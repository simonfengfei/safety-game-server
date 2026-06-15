const tunnel = require('localtunnel');

(async () => {
  try {
    const t = await tunnel({ port: 3000 });
    console.log('PUBLIC_URL=' + t.url);
    t.on('close', () => process.exit(0));
    t.on('error', () => process.exit(1));
    setInterval(() => {}, 60000);
  } catch(e) {
    console.error('FAIL:', e.message);
    process.exit(1);
  }
})();
