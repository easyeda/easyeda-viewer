const path = require('node:path');
const { mkdirSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../..');
const samples = path.resolve(process.env.ANNOTATION_SAMPLES || path.join(root, '..'));
const html = path.resolve(process.env.ANNOTATION_HTML || path.join(root, 'dist/index.html'));
const output = path.join(root, 'qa/shots/annotations');
mkdirSync(output, { recursive: true });
// 批注界面默认关闭(#annotations-default-off),回归用例显式开启
const url = `${pathToFileURL(html).href}?annotations=1`;
module.exports = {
  html, url, output,
  primary: path.join(samples, 'PCB布局布线测试'),
  secondary: path.join(samples, '[五等分的花嫁]AI8051U彩色开发板')
};
