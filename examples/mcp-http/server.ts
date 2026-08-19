// Programmatic MCP server (Streamable HTTP) sharing one WebVector instance with session mode.
import { WebVector } from 'webvector';
import { serveWebVectorHttp } from 'webvector-mcp';

const webvector = new WebVector({ store: { mode: 'session' }, retrieval: { topK: 8 } });
const { url, close } = await serveWebVectorHttp({ webvector, port: 3333 });
console.log(`MCP endpoint: ${url}  (health: /health)`);
process.on('SIGINT', () => void close().then(() => process.exit(0)));
