module.exports = {
  apps: [
    {
      name: "whatsapp-manager",
      script: "server.js",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
      env: {
        NODE_ENV: "production",
        PORT: 3010,
        APP_ROLE: "backoffice",
        CHAT_CORE_INTERNAL_URL: "http://127.0.0.1:3012",
      },
    },
    {
      name: "whatsapp-chat-core",
      script: "server.js",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
      env: {
        NODE_ENV: "production",
        PORT: 3012,
        APP_ROLE: "chat_core",
      },
    },
  ],
};
