'use strict';

{
  const api = window.__waProPortalCommon;
  if (api) {
    const entityNifSelectors = [
      'input[name="login:nifDecorator:entityNif"]',
      'input[id="login:nifDecorator:entityNif"]',
      'input[id*="entityNif" i]',
      'input[name*="entityNif" i]',
      'input[class*="nif" i]',
      'input[name*="nif" i]',
      'input[id*="nif" i]',
    ];

    api.register('RELATORIO_UNICO', {
      selectors: {
        username: [
          'input[name="login:labelDecorator:username"]',
          'input[id="login:labelDecorator:username"]',
          'input[id*="username" i]',
          'input[name*="username" i]',
          'input[name*="user" i]',
          'input[id*="user" i]',
          'input[name*="utilizador" i]',
          'input[id*="utilizador" i]',
          'input[name*="login" i]',
          'input[id*="login" i]',
          'input[type="text"]',
        ],
        password: [
          'input[name="login:passwordDecorator:password"]',
          'input[id="login:passwordDecorator:password"]',
          'input[name="password"]',
          'input[id*="password" i]',
          'input[name*="pass" i]',
          'input[id*="pass" i]',
          'input[name*="senha" i]',
          'input[id*="senha" i]',
          'input[type="password"]',
        ],
        submit: [
          'button[type="submit"]',
          'input[type="submit"]',
          'input[type="button"]',
          'button',
          '[role="button"]',
        ],
      },
      async extraFill(payload) {
        if (!payload.entityNif) return;
        const input = api.findFirst(entityNifSelectors);
        if (input) api.dispatchInput(input, String(payload.entityNif || ''));
      },
    });
  }
}
