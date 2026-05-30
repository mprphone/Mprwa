'use strict';

{
  const api = window.__waProPortalCommon;
  if (api) {
    api.register('IAPMEI', {
      selectors: {
        username: [
          'input[name="NIF"]',
          'input[id*="NIF" i]',
          'input[name*="nif" i]',
          'input[id*="nif" i]',
          'input[type="text"]',
        ],
        password: [
          'input[name="Password"]',
          'input[id*="Password" i]',
          'input[name*="password" i]',
          'input[id*="password" i]',
          'input[type="password"]',
        ],
        submit: [
          'input[type="image"]',
          'input[type="submit"]',
          'button[type="submit"]',
          'input[value*="OK" i]',
          'button',
        ],
      },
    });
  }
}
