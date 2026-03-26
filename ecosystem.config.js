// PM2 process manager configuration for Windows Server deployment
// Usage:
//   pm2 start ecosystem.config.js
//   pm2 save
//   pm2 startup   (follow the printed instructions to auto-start on boot)

module.exports = {
  apps: [
    {
      name: "trackit-mcp",
      script: "dist/server.js",
      cwd: __dirname,

      // Restart policy
      restart_delay: 5000,    // wait 5s before restarting after a crash
      max_restarts: 10,       // give up after 10 consecutive crashes
      min_uptime: "10s",      // must stay up 10s to be counted as successful start

      // Environment
      env: {
        NODE_ENV: "production",
      },

      // Logging
      out_file: "logs/out.log",
      error_file: "logs/error.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss",

      // Single instance (token cache is in-process; don't cluster)
      instances: 1,
    },
  ],
};
