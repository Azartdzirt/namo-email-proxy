module.exports = {
  apps: [{
    name: 'email-proxy',
    script: 'index.js',
    cwd: '/home/namodev/email-proxy',
    instances: 1,
    exec_mode: 'fork',
    watch: false,
    env: {
      NODE_ENV: 'production',
      PORT: 3025,
      PROXY_SECRET: 'EwFRiCWj7HnCsJUrJ8BTLk7pE4SBlch',
      CRM_URL: 'https://fd2a649b-8707-4e38-8086-68a4ac4721f8.vip.gensparksite.com'
    }
  }]
};
