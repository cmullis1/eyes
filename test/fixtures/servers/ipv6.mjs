// Fixture dev server that listens on the IPv6 loopback (::1) only, like Vite's default on Windows.
import http from 'node:http';

const port = Number(process.argv[2]);
http
  .createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<h1 id="h">served over ipv6</h1>');
  })
  .listen(port, '::1', () => console.log(`listening on [::1]:${port}`));
