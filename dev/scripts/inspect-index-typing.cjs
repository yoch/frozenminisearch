#!/usr/bin/env node
'use strict'

// Reports the TypeScript types of every numeric element access in src/,
// component by component. Use it before tuning an index expression for the
// Bun AOT compiler: `--explain` entries name a base or a component, and only a
// component whose type is not `number` can be fixed by rewriting the index.
//
// usage: node dev/scripts/inspect-index-typing.cjs [--all] [--suspect-only] [file-substring...]

const path = require('node:path')
const ts = require(path.join(__dirname, '../../node_modules/typescript'))

const ROOT = path.resolve(__dirname, '../..')
const configPath = path.join(ROOT, 'tsconfig.json')
const configFile = ts.readConfigFile(configPath, ts.sys.readFile)
if (configFile.error) {
  console.error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'))
  process.exit(1)
}
const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, ROOT, {}, configPath)
const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options })
const checker = program.getTypeChecker()

const args = process.argv.slice(2)
const showAll = args.includes('--all')
const suspectOnly = args.includes('--suspect-only')
const filters = args.filter((a) => !a.startsWith('--'))

const FLAGS = ts.TypeFlags
const NUMERIC_FLAGS = FLAGS.Number | FLAGS.NumberLiteral | FLAGS.EnumLiteral
const STRINGISH_FLAGS =
  FLAGS.String | FLAGS.StringLiteral | FLAGS.TemplateLiteral |
  FLAGS.ESSymbol | FLAGS.UniqueESSymbol

function isDefinitelyNumber(type) {
  if (type.flags & FLAGS.TypeParameter) {
    const constraint = checker.getBaseConstraintOfType(type)
    return constraint != null && isDefinitelyNumber(constraint)
  }
  if (type.isUnion()) return type.types.every(isDefinitelyNumber)
  if (type.isIntersection()) return type.types.some(isDefinitelyNumber)
  if (type.flags & FLAGS.EnumLike) {
    const values = type.isUnion() ? type.types : [type]
    return values.every((v) => v.flags & NUMERIC_FLAGS || v.flags & FLAGS.EnumLiteral)
  }
  return (type.flags & NUMERIC_FLAGS) !== 0
}

function mentionsStringish(type) {
  if (type.isUnion() || type.isIntersection()) return type.types.some(mentionsStringish)
  if (type.flags & FLAGS.TypeParameter) {
    const constraint = checker.getBaseConstraintOfType(type)
    return constraint != null && mentionsStringish(constraint)
  }
  return (type.flags & STRINGISH_FLAGS) !== 0
}

function mentionsNumber(type) {
  if (type.isUnion() || type.isIntersection()) return type.types.some(mentionsNumber)
  if (type.flags & FLAGS.TypeParameter) {
    const constraint = checker.getBaseConstraintOfType(type)
    return constraint != null && mentionsNumber(constraint)
  }
  return (type.flags & NUMERIC_FLAGS) !== 0
}

function typeText(type) {
  let text = checker.typeToString(
    type,
    undefined,
    ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope,
  )
  if (text.length > 90) text = text.slice(0, 87) + '...'
  return text
}

const ARITHMETIC = new Set([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.AsteriskAsteriskToken,
  ts.SyntaxKind.BarToken,
  ts.SyntaxKind.AmpersandToken,
  ts.SyntaxKind.CaretToken,
  ts.SyntaxKind.LessThanLessThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
])

function unwrap(node) {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression?.(node)
  ) {
    node = node.expression
  }
  return node
}

function indexComponents(node) {
  node = unwrap(node)
  if (ts.isBinaryExpression(node) && ARITHMETIC.has(node.operatorToken.kind)) {
    return [...indexComponents(node.left), ...indexComponents(node.right)]
  }
  if (
    ts.isPrefixUnaryExpression(node) &&
    (node.operator === ts.SyntaxKind.MinusToken ||
      node.operator === ts.SyntaxKind.PlusToken ||
      node.operator === ts.SyntaxKind.TildeToken)
  ) {
    return indexComponents(node.operand)
  }
  return [node]
}

function enclosingFunctionName(node) {
  for (let p = node.parent; p != null; p = p.parent) {
    if (ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p)) {
      return p.name?.getText() || '(anon)'
    }
    if (ts.isMethodDeclaration(p) || ts.isGetAccessor(p) || ts.isSetAccessor(p)) {
      return p.name?.getText?.() || '(method)'
    }
    if (ts.isArrowFunction(p)) {
      const parent = p.parent
      if (ts.isVariableDeclaration(parent) && parent.name) return parent.name.getText()
      if (ts.isPropertyAssignment(parent) && parent.name) return `${parent.name.getText()} (arrow)`
    }
    if (ts.isConstructorDeclaration(p)) return 'constructor'
  }
  return '(top)'
}

function lineCol(sf, pos) {
  const lc = sf.getLineAndCharacterOfPosition(pos)
  return `${lc.line + 1}:${lc.character + 1}`
}

let numericTotal = 0
let keyTotal = 0
const suspects = []
const byFile = new Map()

for (const sf of program.getSourceFiles()) {
  const file = sf.fileName
  if (!file.startsWith(path.join(ROOT, 'src') + path.sep)) continue
  if (/\.test\.[cm]?[jt]s$/.test(file)) continue
  if (filters.length > 0 && !filters.some((f) => file.includes(f))) continue

  const rel = path.relative(ROOT, file)
  const rows = []

  const visit = (node) => {
    if (ts.isElementAccessExpression(node)) {
      const indexType = checker.getTypeAtLocation(node.argumentExpression)
      // String/symbol-keyed access to a record is not an index form we care
      // about; keep only accesses whose index type involves a number.
      const numeric = mentionsNumber(indexType) || !mentionsStringish(indexType)
      if (!numeric) {
        keyTotal++
        return
      }
      const baseType = checker.getTypeAtLocation(node.expression)
      const comps = indexComponents(node.argumentExpression).map((c) => {
        const t = checker.getTypeAtLocation(c)
        return { text: c.getText(), type: typeText(t), ok: isDefinitelyNumber(t) }
      })
      const bad = comps.filter((c) => !c.ok)
      const row = {
        where: `${rel}:${lineCol(sf, node.getStart(sf))}`,
        fn: enclosingFunctionName(node),
        base: typeText(baseType),
        access: `[${node.argumentExpression.getText()}]`,
        comps,
        bad,
      }
      rows.push(row)
      numericTotal++
      if (bad.length > 0) suspects.push(row)
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)

  if (rows.length > 0) byFile.set(rel, rows)
}

for (const [rel, rows] of byFile) {
  const badRows = rows.filter((r) => r.bad.length > 0)
  if (suspectOnly && badRows.length === 0) continue
  console.log(`\n## ${rel}  (${rows.length} numeric accesses, ${badRows.length} with a non-number component)`)
  for (const r of suspectOnly ? badRows : rows) {
    if (r.bad.length === 0) {
      if (suspectOnly || (!showAll && rows.length > 12 && filters.length === 0)) continue
      console.log(`  ok    ${r.where} [${r.fn}] base=${r.base} ${r.access}`)
      if (showAll) {
        console.log(`        components: ${r.comps.map((c) => `${c.text}: ${c.type}`).join('  |  ')}`)
      }
      continue
    }
    console.log(`  FLAG  ${r.where} [${r.fn}] base=${r.base} ${r.access}`)
    console.log(`        components: ${r.comps.map((c) => `${c.text}: ${c.type}${c.ok ? '' : '  <-- NOT number'}`).join('  |  ')}`)
  }
}

console.log(`\n${numericTotal} numeric element accesses, ${keyTotal} string/symbol-keyed, ${suspects.length} with at least one component not guaranteed to be a number.`)

if (suspects.length > 0) {
  const byType = new Map()
  for (const r of suspects) {
    for (const c of r.bad) byType.set(c.type, (byType.get(c.type) || 0) + 1)
  }
  console.log('\nNon-number component types (most common first):')
  for (const [t, n] of [...byType].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${t}`)
  }
}
