# Publicação na Chrome Web Store — WA PRO Auto Login

Objetivo: publicar como **Não listada** para os utilizadores instalarem por link privado e receberem updates automáticos pelo Chrome.

## 1. Gerar ZIP para upload

Na raiz do projeto:

```bash
npm run extension:zip
```

Ficheiro para upload:

```txt
release/WA-PRO-Chrome-Extension-Store-vX.Y.Z.zip
```

## 2. Chrome Web Store Developer Dashboard

1. Abrir: https://chrome.google.com/webstore/devconsole
2. Criar novo item.
3. Fazer upload do ZIP `WA-PRO-Chrome-Extension-Store-vX.Y.Z.zip`.
4. Preencher descrição, ícones e screenshots.
5. Em distribuição/visibilidade, escolher **Unlisted / Não listada**.
6. Usar como privacy policy URL:

```txt
https://wa.mpr.pt/chrome-extension-privacy.html
```

7. Enviar para revisão.

## 3. Depois de aprovado

Guardar o link privado da Store, algo parecido com:

```txt
https://chromewebstore.google.com/detail/wa-pro-auto-login/EXTENSION_ID
```

Depois configurar a app web com:

```txt
VITE_CHROME_EXTENSION_STORE_URL=https://chromewebstore.google.com/detail/wa-pro-auto-login/EXTENSION_ID
```

e fazer novo build da web app.

## 4. Atualizações futuras

1. Alterar `version` em `chrome-extension/manifest.json` para um número maior.
2. Correr `npm run extension:zip`.
3. Subir o novo ZIP no mesmo item da Chrome Web Store.
4. Depois da revisão, o Chrome atualiza automaticamente nos utilizadores que instalaram pela Store.

Nota: instalações feitas por “Carregar expandida” não migram automaticamente para a Store. Nesses PCs é melhor remover a extensão developer e instalar pelo link privado da Store uma vez.
