import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const script = new URL('../../../deploy/skills/web-content-fetcher/scripts/fetch_content.py', import.meta.url);
const python = process.env.WEB_CONTENT_FETCHER_PYTHON || 'python3';
const responseLimit = 8 * 1024 * 1024;
const defaultUserAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const article = '<!doctype html><html><head><title>测试文章</title></head><body><nav>导航</nav>'
  + '<article><h1>短文章</h1><p>真正的正文。<strong>重点</strong></p><p><a href="https://example.com/source">来源</a></p>'
  + '<img src="placeholder.gif" data-src="https://example.com/image.png" alt="配图">'
  + '<pre><code>print(42)</code></pre></article><script>secretScript()</script><footer>页脚</footer></body></html>';
let server;
let origin;
const literalRequests = [];

function run(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, args, { stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function fetch(path, args = []) {
  const target = path.startsWith('/') ? origin + path : path;
  const execution = await run([script.pathname, target, ...args]);
  assert.ok(execution.stdout.trim(), `CLI returned no JSON: ${JSON.stringify(execution)}`);
  return { ...execution, result: JSON.parse(execution.stdout) };
}

before(async () => {
  server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    if (request.url.startsWith('/literal')) {
      literalRequests.push(request.url);
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ path: request.url }));
      return;
    }
    switch (request.url) {
      case '/article': response.end(article); break;
      case '/short': response.end('<html><body><nav>导航</nav><article>好。</article></body></html>'); break;
      case '/redirect': response.writeHead(302, { location: '/article' }).end(); break;
      case '/file-redirect': response.writeHead(302, { location: 'file:///etc/passwd' }).end(); break;
      case '/forbidden': response.writeHead(403).end('<h1>Forbidden</h1>'); break;
      case '/partial': response.writeHead(200, { 'content-length': '1024', connection: 'close' }).end('partial'); break;
      case '/timeout': response.writeHead(200); response.write('waiting'); break;
      case '/binary': response.writeHead(200, { 'content-type': 'application/pdf' }).end('%PDF-1.4'); break;
      case '/empty': response.writeHead(204).end(); break;
      case '/whitespace': response.end('   '); break;
      case '/shell': response.end('<html><head><title>App</title></head><body><script>render()</script></body></html>'); break;
      case '/challenge': response.end('<html><head><title>Please wait...</title></head><body>Checking browser</body></html>'); break;
      case '/wechat-challenge': response.end('<html><body><div id="js_verify"><h2>环境异常</h2>当前环境异常，完成验证后即可继续访问。去验证</div></body></html>'); break;
      case '/verify-article': response.end('<html><head><title>验证方案</title></head><body><article>短文讨论验证。当前环境异常，完成验证后即可继续访问，这是一段示例提示。</article></body></html>'); break;
      case '/large-article': response.end('<html><head><title>包含页面脚本的短文</title></head><body>'
        + `<script>${'x'.repeat(Math.floor(3.8 * 1024 * 1024))}</script>`
        + '<article>实际需要阅读的正文很短。</article></body></html>'); break;
      case '/oversize': response.writeHead(200, { 'content-length': responseLimit + 1 }).end('a'.repeat(responseLimit + 1)); break;
      case '/chunked-oversize': response.writeHead(200); response.write('a'.repeat(responseLimit)); response.end('b'.repeat(4096)); break;
      case '/complex': response.end('<i>'.repeat(50_001)); break;
      case '/long-text': response.writeHead(200, { 'content-type': 'text/plain' }).end('文'.repeat(50_001)); break;
      case '/header': response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ value: request.headers['x-test'] })); break;
      case '/user-agent': response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ value: request.headers['user-agent'] })); break;
      default: response.writeHead(404).end('missing');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

test('CLI extracts Markdown with links, lazy images and code while excluding navigation and scripts', async () => {
  const { status, result } = await fetch('/article');
  assert.equal(status, 0);
  assert.equal(result.error, null);
  assert.equal(result.title, '测试文章');
  assert.equal(result.status_code, 200);
  assert.equal(result.format, 'markdown');
  assert.equal(result.truncated, false);
  assert.match(result.content, /# 短文章/u);
  assert.match(result.content, /\[来源\]\(https:\/\/example.com\/source\)/u);
  assert.match(result.content, /!\[配图\]\(https:\/\/example.com\/image.png\)/u);
  assert.match(result.content, /print\(42\)/u);
  assert.doesNotMatch(result.content, /导航|页脚|secretScript|placeholder/u);
});

test('text mode returns plain text and short selected articles remain valid', async () => {
  const plain = await fetch('/article', ['--format', 'text']);
  assert.equal(plain.status, 0);
  assert.equal(plain.result.format, 'text');
  assert.match(plain.result.content, /短文章/u);
  assert.doesNotMatch(plain.result.content, /\*\*|\]\(|<h1>|导航|页脚/u);
  const short = await fetch('/short', ['--format', 'text']);
  assert.equal(short.status, 0);
  assert.equal(short.result.content, '好。');
});

test('HTML mode preserves raw source and redirects retain final URL and metadata', async () => {
  const raw = await fetch('/redirect', ['--format', 'html']);
  assert.equal(raw.status, 0);
  assert.equal(raw.result.url, origin + '/redirect');
  assert.equal(raw.result.final_url, origin + '/article');
  assert.equal(raw.result.format, 'html');
  assert.equal(raw.result.content, article);
  assert.equal(raw.result.content_type, 'text/html; charset=utf-8');
});

test('HTTP failures, partial transfers and timeout never become successful partial content', async () => {
  for (const [path, pattern] of [['/forbidden', /HTTP 403/u], ['/partial', /curl 请求失败/u], ['/timeout', /超时/u]]) {
    const actual = await fetch(path, ['--timeout', '0.25']);
    assert.equal(actual.status, 1, actual.stderr);
    assert.match(actual.result.error, pattern);
    assert.equal(actual.result.content, '');
  }
});

test('unsupported types, empty responses, JS shells and explicit challenge pages report failure', async () => {
  for (const [path, pattern] of [['/binary', /不支持的正文类型/u], ['/empty', /正文为空/u],
    ['/whitespace', /可读正文/u], ['/shell', /可读正文/u], ['/challenge', /登录或验证/u], ['/wechat-challenge', /环境验证/u]]) {
    const actual = await fetch(path);
    assert.equal(actual.status, 1);
    assert.match(actual.result.error, pattern);
    assert.equal(actual.result.content, '');
  }
  const valid = await fetch('/verify-article');
  assert.equal(valid.status, 0);
  assert.match(valid.result.content, /短文讨论验证/u);
});

test('bounds known and chunked bodies, parsing complexity and output length', async () => {
  for (const path of ['/oversize', '/chunked-oversize']) {
    const actual = await fetch(path);
    assert.equal(actual.status, 1);
    assert.match(actual.result.error, /字节上限/u);
    assert.equal(actual.result.content, '');
  }
  const complex = await fetch('/complex');
  assert.equal(complex.status, 1);
  assert.match(complex.result.error, /解析上限/u);
  const long = await fetch('/long-text');
  assert.equal(long.status, 0);
  assert.equal(long.result.content.length, 50_000);
  assert.equal(long.result.truncated, true);
});

test('accepts multi-megabyte HTML script overhead while extracting only the short article', async () => {
  const actual = await fetch('/large-article');
  assert.equal(actual.status, 0, actual.result.error);
  assert.equal(actual.result.error, null);
  assert.equal(actual.result.title, '包含页面脚本的短文');
  assert.equal(actual.result.content, '实际需要阅读的正文很短。');
  assert.equal(actual.result.truncated, false);
});

test('sends the complete desktop browser user agent in the HTTP request', async () => {
  const actual = await fetch('/user-agent');
  assert.equal(actual.status, 0, actual.result.error);
  assert.equal(JSON.parse(actual.result.content).value, defaultUserAgent);
});

test('validates URL schemes, redirect protocols and custom header boundaries', async () => {
  for (const target of ['file:///etc/passwd', 'ftp://example.com/test', 'http://127.0.0.1:bad/',
    'http://', 'https://user:password@example.com/', 'https://example.com/ bad']) {
    const actual = await fetch(target);
    assert.equal(actual.status, 1);
    assert.match(actual.result.error, /HTTP\/HTTPS/u);
  }
  const redirected = await fetch('/file-redirect');
  assert.equal(redirected.status, 1);
  assert.match(redirected.result.error, /curl 请求失败/u);
  const header = await fetch('/header', ['--headers', 'X-Test: value']);
  assert.equal(header.status, 0);
  assert.equal(JSON.parse(header.result.content).value, 'value');
  const invalidHeader = await fetch('/header', ['--headers', 'X-Test: value\r\nInjected: yes']);
  assert.equal(invalidHeader.status, 1);
  assert.match(invalidHeader.result.error, /单行/u);
});

test('square brackets and braces in URLs are fetched literally once without curl glob expansion', async () => {
  for (const path of ['/literal?filter[title]=weather', '/literal/{first,second}']) {
    const before = literalRequests.length;
    const actual = await fetch(path);
    assert.equal(actual.status, 0, actual.result.error);
    assert.equal(JSON.parse(actual.result.content).path, path);
    assert.deepEqual(literalRequests.slice(before), [path]);
    assert.equal(actual.result.final_url, origin + path);
  }
});

test('supports JSON output files, proper Feishu routing and standard argument errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'web-content-fetcher-test-'));
  try {
    const output = join(directory, 'article.json');
    const actual = await run([script.pathname, origin + '/short', '--output', output]);
    assert.equal(actual.status, 0);
    assert.equal(actual.stdout, '');
    assert.equal(JSON.parse(await readFile(output, 'utf8')).content, '好。');
    const unsavable = await run([script.pathname, origin + '/short', '--output', join(directory, 'missing', 'file')]);
    assert.equal(unsavable.status, 1);
    assert.match(unsavable.stderr, /保存结果失败/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  const feishu = await fetch('https://example.feishu.cn/wiki/document');
  assert.equal(feishu.status, 2);
  assert.equal(feishu.result.method, 'feishu_redirect');
  for (const flag of ['--help', '-h']) {
    const help = await run([script.pathname, flag]);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /usage:/u);
  }
  for (const value of ['0', '-1', '121', 'nan', 'inf']) {
    const invalid = await run([script.pathname, origin + '/short', '--timeout', value]);
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /timeout/u);
  }
});

test('WeChat selector chooses target body over unrelated surrounding content', async () => {
  const code = `import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('fetch_content', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(json.dumps(module.extract_html(sys.stdin.read(), 'https://mp.weixin.qq.com/s/example', 'markdown'), ensure_ascii=False))`;
  const html = '<html><head><title>微信文章</title></head><body><p>关注及推荐</p>'
    + '<div id="js_content" style="visibility:hidden"><p>真正的微信正文。</p></div><p>相关推荐</p></body></html>';
  const actual = await run(['-c', code, script.pathname], html);
  assert.equal(actual.status, 0, actual.stderr);
  const [title, content] = JSON.parse(actual.stdout);
  assert.equal(title, '微信文章');
  assert.equal(content, '真正的微信正文。');
});

test('WeChat articles with an empty HTML title use the article heading', async () => {
  const code = `import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('fetch_content', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(json.dumps(module.extract_html(sys.stdin.read(), 'https://mp.weixin.qq.com/s/example', 'markdown'), ensure_ascii=False))`;
  const html = '<html><head><title>   </title></head><body>'
    + '<h1 id="activity-name">公众号真实标题</h1>'
    + '<div id="js_content"><p>文章正文。</p></div></body></html>';
  const actual = await run(['-c', code, script.pathname], html);
  assert.equal(actual.status, 0, actual.stderr);
  const [title, content] = JSON.parse(actual.stdout);
  assert.equal(title, '公众号真实标题');
  assert.equal(content, '文章正文。');
});

test('WeChat pages without an article body fail rather than returning shell or recommendation text', async () => {
  const code = `import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('fetch_content', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
try:
    value = module.extract_html(sys.stdin.read(), 'https://mp.weixin.qq.com/s/example', 'text')
    print(json.dumps({'content': value[1]}, ensure_ascii=False))
except module.FetchError as error:
    print(json.dumps({'error': str(error)}, ensure_ascii=False))`;
  for (const html of [
    '<html><head><title>微信公众号</title></head><body><p>关注公众号查看更多文章</p></body></html>',
    '<html><body><h1 id="activity-name">文章标题</h1><div id="js_content">   </div><main>相关推荐</main></body></html>',
  ]) {
    const actual = await run(['-c', code, script.pathname], html);
    assert.equal(actual.status, 0, actual.stderr);
    const result = JSON.parse(actual.stdout);
    assert.equal(typeof result.error, 'string');
    assert.match(result.error, /未取得目标正文/u);
    assert.equal(result.content, undefined);
  }
});

test('WeChat environment text without a title fails unless an actual article container exists', async () => {
  const code = `import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('fetch_content', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
try:
    value = module.extract_html(sys.stdin.read(), 'https://mp.weixin.qq.com/s/example', 'text')
    print(json.dumps({'content': value[1]}, ensure_ascii=False))
except module.FetchError as error:
    print(json.dumps({'error': str(error)}, ensure_ascii=False))`;
  const challenge = await run(['-c', code, script.pathname], '<html><body>环境异常 当前环境异常，完成验证后即可继续访问。去验证</body></html>');
  assert.equal(challenge.status, 0, challenge.stderr);
  assert.match(JSON.parse(challenge.stdout).error, /环境验证/u);
  const articleWithExample = '<html><head><title>环境异常</title></head><body><div id="js_content">'
    + '本文讨论“当前环境异常，完成验证后即可继续访问”提示。</div></body></html>';
  const valid = await run(['-c', code, script.pathname], articleWithExample);
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(JSON.parse(valid.stdout).content, /本文讨论/u);
});
