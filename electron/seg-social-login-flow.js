'use strict';

const {
  runSegSocialEnterpriseSubUserSetupFlow,
  runSegSocialSubUserSetupFlow,
  runSegSocialActivationTokenSetupFlow,
  isSegSocialContinueIntermediatePage,
  detectSegSocialManualRequired,
  dismissSegSocialActivationOfferForSubUser,
  isSegSocialTwoFactorActivationCompleted,
  handleSegSocialEmailVerificationCodeChallenge,
  clickContinueLoginIf2faPrompt,
  isSegSocialTwoFactorActivationPrompt,
  openSegSocialLoginEntryIfNeeded,
  ensureSegSocialCredentialsFormVisible,
  clickContinueWithoutActivatingIfPrompt,
  clickContinuePasswordExpiryPrompt,
  clickContinueToSegSocialPrompt,
} = require('./seg-social');

async function prepareSegSocialCredentialsPage(page, config) {
  await openSegSocialLoginEntryIfNeeded(page, Math.min(12_000, config.timeoutMs));
  await ensureSegSocialCredentialsFormVisible(page, Math.min(12_000, config.timeoutMs));
}

function createSegSocialFlowController(page, payload, config) {
  const controller = {
    manualRequiredReason: '',
    postLoginFlowResult: null,
    async resolveEmailCodeIfPresent() {
      if (
        controller.manualRequiredReason ||
        config.normalizedCredentialLabel !== 'SS' ||
        config.isEnterpriseSubUserFlow
      ) {
        return { handled: false, manualRequired: false, reason: '' };
      }

      const result = await handleSegSocialEmailVerificationCodeChallenge(
        page,
        payload,
        config.segSocialLoginVerificationSinceIso
      ).catch((error) => ({
        handled: true,
        manualRequired: true,
        reason: `Não consegui tratar o código por email automaticamente: ${error?.message || error}`,
      }));

      if (result?.manualRequired) {
        controller.manualRequiredReason = result.reason || 'Validação por código de email necessária.';
      }
      return result;
    },
    async activationTokenFlowReady() {
      return (
        config.normalizedCredentialLabel === 'SS' &&
        config.isSegSocialActivationTokenFlow &&
        await isSegSocialTwoFactorActivationCompleted(page).catch(() => false)
      );
    },
    setManualRequired(reason) {
      if (!controller.manualRequiredReason) {
        controller.manualRequiredReason = reason || 'Validação manual necessária.';
      }
    },
  };

  return controller;
}

async function clickSegSocialContinueIfNeeded(page, config, controller, timeoutMs) {
  if (controller.manualRequiredReason || await controller.activationTokenFlowReady()) return;

  const shouldSkipLegacyContinue =
    config.isLegacySubUserFlow && !await isSegSocialContinueIntermediatePage(page).catch(() => false);
  const result = shouldSkipLegacyContinue
    ? { clicked: false, manualRequired: false }
    : await clickContinueToSegSocialPrompt(page, Math.min(timeoutMs, config.timeoutMs));

  if (result?.manualRequired) {
    await controller.resolveEmailCodeIfPresent();
    controller.setManualRequired(result.reason || 'Validação manual necessária.');
  }
}

async function handleSegSocialInitialTransition(page, config, controller) {
  await controller.resolveEmailCodeIfPresent();

  if (config.isEnterpriseSubUserFlow) {
    await Promise.race([
      page.waitForLoadState('domcontentloaded', { timeout: Math.min(8000, config.timeoutMs) }).catch(() => null),
      page.waitForTimeout(900),
    ]);
    return;
  }

  if (config.isLegacySubUserFlow) {
    if (await isSegSocialTwoFactorActivationPrompt(page).catch(() => false)) {
      await clickContinueWithoutActivatingIfPrompt(page, Math.min(2500, config.timeoutMs));
    }
    return;
  }

  if (!controller.manualRequiredReason && !(await controller.activationTokenFlowReady())) {
    await clickContinueLoginIf2faPrompt(page, Math.min(12_000, config.timeoutMs));
    await controller.resolveEmailCodeIfPresent();
  }
}

async function handleSegSocialIntermediatePages(page, config, controller) {
  if (config.normalizedCredentialLabel !== 'SS' || config.isEnterpriseSubUserFlow) return;

  if (config.isLegacySubUserFlow && await isSegSocialTwoFactorActivationPrompt(page).catch(() => false)) {
    await clickContinueWithoutActivatingIfPrompt(page, Math.min(2500, config.timeoutMs));
  }

  await controller.resolveEmailCodeIfPresent();
  await clickSegSocialContinueIfNeeded(page, config, controller, 12_000);

  if (config.isLegacySubUserFlow) {
    if (await isSegSocialTwoFactorActivationPrompt(page).catch(() => false)) {
      await clickContinueWithoutActivatingIfPrompt(page, Math.min(2500, config.timeoutMs));
    }
  } else if (!config.isSegSocialActivationTokenFlow) {
    await clickContinueWithoutActivatingIfPrompt(page, Math.min(18_000, config.timeoutMs));
  }

  if (await isSegSocialContinueIntermediatePage(page).catch(() => false)) {
    await clickContinuePasswordExpiryPrompt(page, Math.min(12_000, config.timeoutMs));
  }

  await controller.resolveEmailCodeIfPresent();
  await clickSegSocialContinueIfNeeded(page, config, controller, 8_000);
  await controller.resolveEmailCodeIfPresent();

  if (!controller.manualRequiredReason && !(await controller.activationTokenFlowReady())) {
    const manualState = await detectSegSocialManualRequired(page).catch(() => ({ manualRequired: false, reason: '' }));
    if (manualState.manualRequired) {
      await controller.resolveEmailCodeIfPresent();
      controller.setManualRequired(manualState.reason || 'Validação manual necessária.');
    }
  }

  if (
    !controller.manualRequiredReason &&
    !(await controller.activationTokenFlowReady()) &&
    await isSegSocialContinueIntermediatePage(page).catch(() => false)
  ) {
    throw new Error('A Segurança Social ficou no ecrã "Continuar para a Segurança Social Direta"; o botão não foi clicado automaticamente.');
  }
}

async function runSegSocialPostLoginAutomation(page, context, payload, config, controller) {
  if (controller.manualRequiredReason || config.normalizedCredentialLabel !== 'SS') return;

  if (config.isLegacySubUserFlow) {
    await dismissSegSocialActivationOfferForSubUser(page, Math.min(10_000, config.timeoutMs)).catch(() => false);
  }

  if (config.isEnterpriseSubUserFlow) {
    controller.postLoginFlowResult = await runSegSocialEnterpriseSubUserSetupFlow(page, payload);
  } else if (config.isLegacySubUserFlow) {
    controller.postLoginFlowResult = await runSegSocialSubUserSetupFlow(page, payload, context);
  } else if (config.isSegSocialActivationTokenFlow) {
    controller.postLoginFlowResult = await runSegSocialActivationTokenSetupFlow(page, payload);
  }

  if (controller.postLoginFlowResult?.manualRequired) {
    controller.setManualRequired(
      controller.postLoginFlowResult.reason || 'Intervenção manual necessária na Segurança Social.'
    );
  }
}

async function runDesktopAutologinPostSubmitFlow(page, context, payload, config) {
  const controller = createSegSocialFlowController(page, payload, config);

  if (config.normalizedCredentialLabel === 'SS') {
    await handleSegSocialInitialTransition(page, config, controller);
    await handleSegSocialIntermediatePages(page, config, controller);
    await runSegSocialPostLoginAutomation(page, context, payload, config, controller);
  }

  if (!controller.manualRequiredReason && config.targetUrl) {
    await page.goto(config.targetUrl, { waitUntil: 'domcontentloaded' }).catch(() => null);
  }

  return controller;
}


module.exports = {
  prepareSegSocialCredentialsPage,
  runDesktopAutologinPostSubmitFlow,
};
