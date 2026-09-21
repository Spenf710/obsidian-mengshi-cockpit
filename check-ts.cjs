const ts = require('typescript');
const path = require('path');

const program = ts.createProgram(
  ['src/main.ts'],
  {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    esModuleInterop: true,
    skipLibCheck: true,
    strict: false,
    noEmit: true,
    allowJs: true,
  }
);

const diag = ts.getPreEmitDiagnostics(program);
console.log('总诊断数:', diag.length);
diag.slice(0, 30).forEach((d) => {
  if (d.file && d.start != null) {
    const pos = d.file.getLineAndCharacterOfPosition(d.start);
    const rel = path.relative(process.cwd(), d.file.fileName);
    console.log(`${rel}:${pos.line + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
  } else {
    console.log(ts.flattenDiagnosticMessageText(d.messageText, ' '));
  }
});
if (diag.length === 0) console.log('✅ 无类型错误');