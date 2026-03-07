/**
 * 测试代理连接 Solana devnet
 */

const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');

const PROXY = process.env.PROXY || 'http://127.0.0.1:7797';
const RPC_URL = 'https://api.devnet.solana.com';

async function testConnection() {
  console.log(`测试代理连接: ${PROXY} -> ${RPC_URL}`);
  
  const agent = new HttpsProxyAgent(PROXY);
  
  const data = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'getHealth'
  });
  
  return new Promise((resolve, reject) => {
    const req = https.request(RPC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      },
      agent: agent
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        console.log('响应状态:', res.statusCode);
        console.log('响应内容:', body);
        resolve(body);
      });
    });
    
    req.on('error', (e) => {
      console.error('请求错误:', e.message);
      reject(e);
    });
    
    req.write(data);
    req.end();
  });
}

testConnection().catch(console.error);