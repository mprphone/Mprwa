'use strict';

const PORTAL_RECIPES = {
    financas: {
        loginUrlEnv: 'PORTAL_FINANCAS_LOGIN_URL',
        defaultLoginUrl: 'https://www.acesso.gov.pt/v2/loginForm?partID=PFAP',
        targetUrlEnv: 'PORTAL_FINANCAS_TARGET_URL',
        headlessEnv: 'PORTAL_FINANCAS_HEADLESS',
        closeAfterSubmitEnv: 'PORTAL_FINANCAS_CLOSE_AFTER_SUBMIT',
        timeoutEnv: 'PORTAL_FINANCAS_TIMEOUT_MS',
        defaultTimeoutMs: 90000,
        credentialPortal: 'financas',
        usernameSelectorEnv: 'PORTAL_FINANCAS_USERNAME_SELECTOR',
        passwordSelectorEnv: 'PORTAL_FINANCAS_PASSWORD_SELECTOR',
        submitSelectorEnv: 'PORTAL_FINANCAS_SUBMIT_SELECTOR',
        successSelectorEnv: 'PORTAL_FINANCAS_SUCCESS_SELECTOR',
        selectors: {
            username: 'form[name="loginForm"] input[name="username"], input[name="username"], input[placeholder*="Contribuinte"], input[aria-label*="Contribuinte"], input[name="representante"], input[name="nif"], input[type="text"]',
            password: 'form[name="loginForm"] input[name="password"], input[name="password"], input[placeholder*="Senha"], input[type="password"]',
            submit: 'form[name="loginForm"] button[type="submit"], form[name="loginForm"] input[type="submit"], button[type="submit"], input[type="submit"], button:has-text("Autenticar")',
            success: 'a[href*="logout"], a[href*="/v2/logout"], [data-testid="logout"], .logout',
        },
    },
    segurancaSocial: {
        loginUrlEnv: 'PORTAL_SEG_SOCIAL_LOGIN_URL',
        defaultLoginUrl: 'https://www.seg-social.pt/sso/login?service=https%3A%2F%2Fwww.seg-social.pt%2Fptss%2Fcaslogin',
        targetUrlEnv: 'PORTAL_SEG_SOCIAL_TARGET_URL',
        headlessEnv: 'PORTAL_SEG_SOCIAL_HEADLESS',
        closeAfterSubmitEnv: 'PORTAL_SEG_SOCIAL_CLOSE_AFTER_SUBMIT',
        timeoutEnv: 'PORTAL_SEG_SOCIAL_TIMEOUT_MS',
        defaultTimeoutMs: 90000,
        credentialPortal: 'seg-social',
        usernameSelectorEnv: 'PORTAL_SEG_SOCIAL_USERNAME_SELECTOR',
        passwordSelectorEnv: 'PORTAL_SEG_SOCIAL_PASSWORD_SELECTOR',
        submitSelectorEnv: 'PORTAL_SEG_SOCIAL_SUBMIT_SELECTOR',
        successSelectorEnv: 'PORTAL_SEG_SOCIAL_SUCCESS_SELECTOR',
        selectors: {
            username: 'input[name="username"], input[name="niss"], input[id*="username" i], input[name*="user" i], input[id*="utilizador" i], input[name*="utilizador" i], input[id*="niss" i], input[placeholder*="NISS" i], input[autocomplete="username"]',
            password: 'input[name="password"], input[id*="password" i], input[placeholder*="senha" i], input[type="password"]',
            submit: 'button:has-text("Entrar"), input[type="submit"][value*="Entrar" i], button:has-text("Iniciar sessão"), button:has-text("Autenticar"), button:has-text("Continuar"), button[type="submit"], input[type="submit"]',
            success: 'a[href*="logout"], a[href*="sair"], button:has-text("Terminar sessão"), button:has-text("Sair"), [data-testid*="logout"]',
        },
    },
    iefp: {
        defaultLoginUrl: 'https://iefponline.iefp.pt/IEFP/authentication/loginUser.jsp',
        defaultTimeoutMs: 90000,
        credentialPortal: 'iefp',
        selectors: {
            username: 'input[name="username"], input[name="niss"], input[id*="username" i], input[autocomplete="username"]',
            password: 'input[name="password"], input[type="password"]',
            submit: 'button[type="submit"], input[type="submit"], button:has-text("Autenticar"), button:has-text("Entrar"), button:has-text("Continuar")',
        },
    },
    viactt: {
        defaultLoginUrl: 'https://www.viactt.pt/fevia/app/auth/checkUser.jspx',
        defaultTimeoutMs: 60000,
        credentialPortal: 'viactt',
        selectors: {
            username: 'input[name="username"], input[id*="username" i], input[type="text"]',
            password: 'input[name="password"], input[type="password"]',
            submit: 'input[type="image"], input[type="submit"], button[type="submit"], a:has-text("Continuar")',
        },
    },
    bportugal: {
        defaultLoginUrl: 'https://clientebancario.bportugal.pt/pt-pt/responsabilidades-de-credito',
        defaultTimeoutMs: 90000,
        credentialPortal: 'bportugal',
        selectors: {
            username: 'form[name="loginForm"] input[name="username"], input[name="username"], input[name="nif"], input[type="text"]',
            password: 'input[name="password"], input[type="password"]',
            submit: 'form[name="loginForm"] button[type="submit"], button[type="submit"], input[type="submit"], button:has-text("Autenticar")',
        },
    },
    iapmei: {
        defaultLoginUrl: 'https://webapps.iapmei.pt/PME/Account/Login.aspx',
        defaultTimeoutMs: 60000,
        credentialPortal: 'iapmei',
        selectors: {
            username: 'input[name="NIF"], input[id*="NIF" i], input[name*="nif" i], input[name*="UserName" i], input[id*="UserName" i], input[type="text"]',
            password: 'input[name="Password"], input[id*="Password" i], input[type="password"]',
            submit: 'input[type="image"], input[type="submit"], button[type="submit"]',
        },
    },
};

function recipe(name) {
    return PORTAL_RECIPES[name] || null;
}

function recipeUrl(name, kind = 'login') {
    const item = recipe(name);
    if (!item) return '';
    const envName = kind === 'target' ? item.targetUrlEnv : item.loginUrlEnv;
    const envValue = envName ? String(process.env[envName] || '').trim() : '';
    if (envValue) return envValue;
    return kind === 'target' ? '' : item.defaultLoginUrl;
}

function recipeTimeout(name) {
    const item = recipe(name);
    if (!item) return 90000;
    return Math.max(
        20000,
        Math.min(180000, Number(process.env[item.timeoutEnv] || item.defaultTimeoutMs) || item.defaultTimeoutMs)
    );
}

function recipeSelectors(name, splitSelectorList) {
    const item = recipe(name);
    if (!item) return {};
    return {
        username: splitSelectorList(process.env[item.usernameSelectorEnv], item.selectors.username),
        password: splitSelectorList(process.env[item.passwordSelectorEnv], item.selectors.password),
        submit: splitSelectorList(process.env[item.submitSelectorEnv], item.selectors.submit),
        success: item.selectors.success
            ? splitSelectorList(process.env[item.successSelectorEnv], item.selectors.success)
            : [],
    };
}

module.exports = {
    PORTAL_RECIPES,
    recipe,
    recipeUrl,
    recipeTimeout,
    recipeSelectors,
};
