// Fixture dev server that answers its first page request, then exits on its own shortly after.
import http from 'node:http';

const port = Number(process.argv[2]);
let served = false;
http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<h1>about to go</h1>');
  if (req.url === '/page' && !served) {
    served = true;
    setTimeout(() => {
      console.log('server going away');
      process.exit(1);
    }, 300);
  }
}).listen(port, '127.0.0.1');
