#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const srcDir = path.join(root, 'src');
const sourceExtensions = new Set(['.ts', '.tsx', '.mts', '.cts']);
const releaseMarkerPattern = /\b(?:TODO|FIXME)\b/;
const findings = [];

function scriptKindFor(filePath) {
  return path.extname(filePath).toLowerCase() === '.tsx'
    ? ts.ScriptKind.TSX
    : ts.ScriptKind.TS;
}

function sourceLine(source, position) {
  const lineStart = source.lastIndexOf('\n', Math.max(0, position - 1)) + 1;
  const nextLine = source.indexOf('\n', position);
  const lineEnd = nextLine === -1 ? source.length : nextLine;
  return source.slice(lineStart, lineEnd).trim();
}

function addFinding(filePath, sourceFile, source, position, message) {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(position);
  const relativePath = path.relative(root, filePath).replace(/\\/g, '/');
  findings.push(
    `${relativePath}:${line + 1}:${character + 1}: ${message}: ${sourceLine(source, position)}`
  );
}

function isConsoleLogCall(node) {
  if (!ts.isCallExpression(node)) {
    return false;
  }

  const expression = node.expression;
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === 'console' &&
    expression.name.text === 'log'
  ) {
    return true;
  }

  return (
    ts.isElementAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === 'console' &&
    ts.isStringLiteralLike(expression.argumentExpression) &&
    expression.argumentExpression.text === 'log'
  );
}

function scanAst(filePath, sourceFile, source) {
  function visit(node) {
    if (ts.isDebuggerStatement(node)) {
      addFinding(filePath, sourceFile, source, node.getStart(sourceFile), 'debugger statement');
    } else if (isConsoleLogCall(node)) {
      addFinding(filePath, sourceFile, source, node.expression.getStart(sourceFile), 'console.log call');
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

function scanComments(filePath, sourceFile, source) {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    source
  );

  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (
      token !== ts.SyntaxKind.SingleLineCommentTrivia &&
      token !== ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      continue;
    }

    const comment = scanner.getTokenText();
    const marker = releaseMarkerPattern.exec(comment);
    if (marker !== null) {
      addFinding(
        filePath,
        sourceFile,
        source,
        scanner.getTokenPos() + marker.index,
        `${marker[0]} comment marker`
      );
    }
  }
}

function scanFile(filePath) {
  if (!sourceExtensions.has(path.extname(filePath).toLowerCase())) {
    return;
  }

  const source = fs.readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(filePath)
  );
  scanAst(filePath, sourceFile, source);
  scanComments(filePath, sourceFile, source);
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath);
    } else if (entry.isFile()) {
      scanFile(fullPath);
    }
  }
}

walk(srcDir);

if (findings.length > 0) {
  console.error('Release marker lint failed:');
  for (const finding of findings) {
    console.error(`  ${finding}`);
  }
  process.exit(1);
}

console.log('Release marker lint passed.');
