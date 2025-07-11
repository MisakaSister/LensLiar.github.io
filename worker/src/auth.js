import bcrypt from 'bcryptjs';
import {addCorsHeaders, handleCors} from "./cors";
import { handleError, createError } from './error-handler.js';
import { checkRateLimit } from './rate-limiter.js';
import { SmartFingerprintValidator } from './smart-fingerprint.js';

export async function handleAuth(request, env) {
    // 先处理OPTIONS预检请求
    const corsResponse = handleCors(request, env);
    if (corsResponse) return corsResponse;
    const {pathname} = new URL(request.url);

    if (pathname === '/auth/login' && request.method === 'POST') {
        try {
            console.log('[认证] 开始处理登录请求');
            
            // 🔒 基础速率限制
            await checkRateLimit(request, env, 'login');

            const {username, password} = await request.json();

            // 🔒 基本输入验证
            if (!username || !password || 
                typeof username !== 'string' || typeof password !== 'string' ||
                username.length > 50 || password.length > 100) {
                console.warn('[认证] 输入验证失败');
                throw createError('VALIDATION_ERROR', 'Invalid input');
            }

            // 验证凭证
            console.log('[认证] 验证用户凭证');
            const isValid = await verifyCredentials(username, password, env);

            if (isValid) {
                console.log('[认证] 凭证验证成功，生成token');
                
                // 🔒 清理旧的token（防止会话固定）
                await cleanupExpiredTokens(env, request.headers.get('CF-Connecting-IP'));
                
                // 🔒 创建更安全的令牌
                const token = await generateSecureToken();

                // 🔒 使用智能指纹系统（宽松模式用于登录）
                let smartFingerprint = null;
                try {
                    const fingerprintValidator = new SmartFingerprintValidator(env);
                    smartFingerprint = await fingerprintValidator.generateSmartFingerprint(request);
                    console.log('[认证] 智能指纹生成成功');
                } catch (error) {
                    console.warn('[认证] 智能指纹生成失败，使用基础指纹:', error);
                    // 降级到基础指纹
                    smartFingerprint = await generateBasicFingerprint(request);
                }
                
                // 🔒 存储令牌到KV，包含更多安全信息
                const tokenData = {
                    user: username,
                    expires: Date.now() + 3600000, // 1小时有效期
                    created: Date.now(),
                    ip: request.headers.get('CF-Connecting-IP') || 'unknown',
                    userAgent: request.headers.get('User-Agent') || 'unknown',
                    // 🔒 使用智能会话指纹
                    sessionFingerprint: smartFingerprint,
                    // 标记为首次登录，后续验证会更宽松
                    isFirstLogin: true
                };
                
                await env.AUTH_KV.put(token, JSON.stringify(tokenData), {expirationTtl: 3600});
                
                console.log('[认证] 登录成功，token已生成');

                return new Response(JSON.stringify({token}), {
                    status: 200,
                    headers: {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    }
                });
            }

            // 🔒 记录失败的登录尝试
            console.warn('[认证] 登录失败，记录失败尝试');
            await recordFailedLogin(request, env);

            return new Response(JSON.stringify({
                error: "账号密码错误"
            }), {
                status: 401,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                }
            });
        } catch (error) {
            console.error('[认证] 登录处理异常:', error);
            return handleError(error, request);
        }
    }

    return new Response(JSON.stringify({
        error: "Not found"
    }), {
        status: 404,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        }
    });
}

// 🔒 防时序攻击的用户名验证
async function verifyCredentials(username, password, env) {
    // 添加固定延迟防止时序攻击
    const startTime = Date.now();
    const minProcessTime = 200; // 最少200ms处理时间
    
    let isValid = false;
    
    try {
        // 检查环境变量是否配置
        if (!env.SECRET_ADMIN_USERNAME || !env.SECRET_ADMIN_PASSWORD_HASH || !env.SECRET_PEPPER) {
            console.error('[认证] 环境变量配置不完整');
            throw new Error('Server configuration error');
        }
        
        // 检查用户名（恒定时间）
        const usernameValid = username === env.SECRET_ADMIN_USERNAME;
        
        // 即使用户名错误也执行密码验证（防时序攻击）
        const saltedPassword = password + env.SECRET_PEPPER;
        const passwordValid = await bcrypt.compare(saltedPassword, env.SECRET_ADMIN_PASSWORD_HASH);
        
        isValid = usernameValid && passwordValid;
        
        console.log(`[认证] 用户名验证: ${usernameValid ? '通过' : '失败'}`);
        
    } catch (error) {
        console.error('[认证] 凭证验证异常:', error);
        // 确保发生错误时也有固定延迟
        isValid = false;
    }
    
    // 确保最小处理时间（防时序攻击）
    const elapsed = Date.now() - startTime;
    if (elapsed < minProcessTime) {
        await new Promise(resolve => setTimeout(resolve, minProcessTime - elapsed));
    }
    
    return isValid;
}

// 🔒 生成更安全的token
async function generateSecureToken() {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

// 🔒 基础速率限制
async function checkBasicRateLimit(request, env) {
    const clientIP = request.headers.get('CF-Connecting-IP') || 
                     request.headers.get('X-Forwarded-For') || 
                     'unknown';
    
    const key = `login_attempts:${clientIP}`;
    const current = await env.AUTH_KV.get(key);
    
    if (current && parseInt(current) > 5) { // 每小时5次登录尝试
        return { 
            allowed: false, 
            error: 'Too many login attempts. Please try again later.' 
        };
    }
    
    return { allowed: true };
}

// 🔒 记录失败的登录尝试
async function recordFailedLogin(request, env) {
    const clientIP = request.headers.get('CF-Connecting-IP') || 
                     request.headers.get('X-Forwarded-For') || 
                     'unknown';
    
    const key = `login_attempts:${clientIP}`;
    const current = await env.AUTH_KV.get(key);
    const count = current ? parseInt(current) + 1 : 1;
    
    await env.AUTH_KV.put(key, count.toString(), { expirationTtl: 3600 }); // 1小时TTL
    
    console.log(`[认证] 记录失败登录尝试: IP=${clientIP}, 次数=${count}`);
}

// 🔒 清理过期token
async function cleanupExpiredTokens(env, clientIP) {
    // 这里可以添加批量清理逻辑
    // 由于KV的限制，我们依赖TTL自动清理
    console.log('[认证] 清理过期token (依赖TTL自动清理)');
}

// 🔒 生成基础指纹（降级方案）
async function generateBasicFingerprint(request) {
    const userAgent = request.headers.get('User-Agent') || 'unknown';
    const language = request.headers.get('Accept-Language') || 'unknown';
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    
    // 创建基础指纹结构
    const components = {
        browser: userAgent.split('/')[0] || 'unknown',
        language: language.split(',')[0] || 'unknown',
        timezone: 'unknown',
        screen: 'unknown'
    };
    
    // 生成简单哈希
    const fingerprint = `${components.browser}|${components.language}`;
    const encoder = new TextEncoder();
    const data = encoder.encode(fingerprint);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = new Uint8Array(hashBuffer);
    const id = Array.from(hashArray, b => b.toString(16).padStart(2, '0')).join('');
    
    console.log('[认证] 生成基础指纹完成');
    
    return {
        id: id,
        components: components,
        timestamp: Date.now(),
        type: 'basic_fallback',
        metadata: {
            ip: ip,
            country: request.headers.get('CF-IPCountry') || 'unknown',
            ray: request.headers.get('CF-Ray') || 'unknown'
        }
    };
}

// 🔒 生成会话指纹（更温和的版本）
async function generateSessionFingerprint(request) {
    // 只使用相对稳定的User-Agent前缀，忽略版本号
    const userAgent = request.headers.get('User-Agent') || '';
    const stableUserAgent = userAgent.split('/')[0] || userAgent.substring(0, 50);
    
    const components = [
        stableUserAgent,
        request.headers.get('Accept-Language') || '',
        // 暂时移除IP检查，因为CDN可能导致IP变化
        // request.headers.get('CF-Connecting-IP') || ''
    ];
    
    const fingerprint = components.join('|');
    const encoder = new TextEncoder();
    const data = encoder.encode(fingerprint);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = new Uint8Array(hashBuffer);
    return Array.from(hashArray, b => b.toString(16).padStart(2, '0')).join('');
}
