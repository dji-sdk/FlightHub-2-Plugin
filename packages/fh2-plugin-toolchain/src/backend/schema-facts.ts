// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PROJECT_PATHS } from '../project-policy.js'
import type { WorkerBackendEntity, WorkerBackendField } from './contract.js'
import { PLATFORM_COLUMN_NAMES, SCHEMA_FIELD_TYPES, SCHEMA_SQL_TYPES } from './policy.js'
import type { SchemaSqlType } from './policy.js'

export type { SchemaSqlType } from './policy.js'

export interface SchemaFieldFact {
  readonly name: string;
  readonly sqlType: SchemaSqlType;
  readonly indexed: boolean;
  readonly unique: boolean;
  readonly primaryKey: boolean;
}

export interface SchemaTableFact {
  /** Physical PostgreSQL table name. */
  readonly name: string;
  readonly columns: readonly SchemaFieldFact[];
}

export interface SchemaEntityFact {
  /** Logical Worker entity name, without the plugin_db_ prefix. */
  readonly name: string;
  readonly tableName: string;
  readonly fields: readonly SchemaFieldFact[];
}

export interface SchemaIndexColumnFact {
  readonly name: string;
  readonly direction: 'ASC' | 'DESC';
}

export interface SchemaIndexPredicateFact {
  readonly column: string;
  readonly kind: 'is-not-null';
}

export interface SchemaIndexFact {
  readonly name: string;
  readonly tableName: string;
  readonly columns: readonly SchemaIndexColumnFact[];
  readonly unique: boolean;
  readonly predicate?: SchemaIndexPredicateFact;
}

export interface SchemaFacts {
  /** All supported tables, kept in their final creation order. */
  readonly tables: readonly SchemaTableFact[];
  /** All surviving indexes, kept in their final creation order. */
  readonly indexes: readonly SchemaIndexFact[];
  /** Business fields from final plugin_db_ tables. */
  readonly entities: readonly SchemaEntityFact[];
}

export interface SchemaFactsDiagnostic {
  readonly code: 'FH2_SCHEMA_SQL_READ_FAILED' | 'FH2_SCHEMA_SQL_INVALID';
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly statement?: number;
  readonly message: string;
}

export class SchemaFactsError extends Error {
  constructor (readonly diagnostics: readonly SchemaFactsDiagnostic[]) {
    super(diagnostics.map(formatDiagnostic).join('\n'))
    this.name = 'SchemaFactsError'
  }
}

/** Columns supplied by the platform rather than a plugin entity declaration. */
export { PLATFORM_COLUMN_NAMES } from './policy.js'

const PLATFORM_COLUMN_SET = new Set(PLATFORM_COLUMN_NAMES)
const PLUGIN_TABLE_PREFIX = 'plugin_db_'

/** Read and parse the schema.sql at a backend plugin root. */
export function readSchemaFacts (pluginRoot: string): SchemaFacts {
  let source: string
  try {
    source = readFileSync(resolve(pluginRoot, PROJECT_PATHS.schemaSql), 'utf8')
  } catch (error) {
    throw new SchemaFactsError([{
      code: 'FH2_SCHEMA_SQL_READ_FAILED',
      file: 'schema.sql',
      line: 1,
      column: 1,
      message: `无法读取 schema.sql：${errorMessage(error)}`,
    }])
  }
  return parseSchemaFacts(source)
}

/**
 * Parse the deliberately small schema.sql grammar used by backend plugins.
 * Unsupported SQL fails instead of being ignored, so generated declarations
 * cannot silently disagree with the deployed schema.
 */
export function parseSchemaFacts (source: string, file = 'schema.sql'): SchemaFacts {
  const tokens = tokenize(source, file)
  const statements = splitTopLevelStatements(tokens, file)
  const parser = new SchemaParser(file)
  for (const [index, statement] of statements.entries()) {
    parser.parseStatement(statement, index + 1)
  }
  return parser.finish()
}

/** Render final schema facts into the current Worker manifest entity shape. */
export function renderWorkerEntities (facts: SchemaFacts): readonly WorkerBackendEntity[] {
  const entities = facts.entities.map((entity) => {
    const fields: Record<string, WorkerBackendField> = {}
    for (const field of entity.fields) {
      fields[field.name] = Object.freeze({
        type: SCHEMA_FIELD_TYPES[field.sqlType],
        ...(field.unique ? { unique: true } : {}),
        ...(!field.unique && field.indexed ? { indexed: true } : {}),
      })
    }
    return Object.freeze({
      name: entity.name,
      fields: Object.freeze(fields),
    })
  })
  return Object.freeze(entities)
}

type TokenKind = 'word' | 'symbol' | 'literal'

interface Token {
  readonly kind: TokenKind;
  readonly text: string;
  readonly line: number;
  readonly column: number;
}

interface MutableColumn {
  readonly name: string;
  readonly sqlType: SchemaSqlType;
  readonly primaryKey: boolean;
  readonly unique: boolean;
  readonly token: Token;
}

interface MutableTable {
  readonly name: string;
  readonly columns: Map<string, MutableColumn>;
}

interface MutableIndexColumn {
  readonly name: string;
  readonly direction: 'ASC' | 'DESC';
  readonly token: Token;
}

interface MutableIndex {
  readonly name: string;
  readonly tableName: string;
  readonly columns: readonly MutableIndexColumn[];
  readonly unique: boolean;
  readonly predicate?: SchemaIndexPredicateFact;
}

interface ColumnIndexState {
  readonly indexed: Set<string>;
  readonly unique: Set<string>;
}

class SchemaParser {
  private readonly tables = new Map<string, MutableTable>()
  private readonly indexes = new Map<string, MutableIndex>()
  private inTransaction = false
  private beginToken: Token | undefined
  private beginStatement: number | undefined

  constructor (private readonly file: string) {}

  parseStatement (tokens: readonly Token[], statement: number): void {
    const cursor = new TokenCursor(tokens, this.file, statement)
    const first = cursor.expectWord('一条 SQL 语句')
    switch (keyword(first)) {
      case 'BEGIN':
        this.parseBegin(cursor, first)
        return
      case 'COMMIT':
        this.parseCommit(cursor, first)
        return
      case 'CREATE':
        this.parseCreate(cursor)
        return
      case 'ALTER':
        this.parseAlter(cursor)
        return
      case 'DROP':
        this.parseDrop(cursor)
        return
      default:
        cursor.fail(first, `不支持的 schema.sql 语句：${JSON.stringify(first.text)}。`)
    }
  }

  finish (): SchemaFacts {
    if (this.inTransaction) {
      throwInvalid(
        this.file,
        this.beginToken!,
        'BEGIN 没有对应的 COMMIT。',
        this.beginStatement,
      )
    }

    const indexState = new Map<string, ColumnIndexState>()
    for (const index of this.indexes.values()) {
      let state = indexState.get(index.tableName)
      if (state === undefined) {
        state = { indexed: new Set<string>(), unique: new Set<string>() }
        indexState.set(index.tableName, state)
      }
      for (const column of index.columns) state.indexed.add(column.name)
      if (index.unique && index.columns.length === 1) {
        state.unique.add(index.columns[0]!.name)
      }
    }

    const tables: SchemaTableFact[] = []
    const entities: SchemaEntityFact[] = []
    for (const table of this.tables.values()) {
      const state = indexState.get(table.name)
      const columns = Object.freeze([...table.columns.values()].map(column => Object.freeze({
        name: column.name,
        sqlType: column.sqlType,
        indexed: column.primaryKey || column.unique || state?.indexed.has(column.name) === true,
        unique: column.unique || state?.unique.has(column.name) === true,
        primaryKey: column.primaryKey,
      })))
      tables.push(Object.freeze({ name: table.name, columns }))

      if (!table.name.startsWith(PLUGIN_TABLE_PREFIX)) continue
      const fields = Object.freeze(columns.filter(column => !PLATFORM_COLUMN_SET.has(column.name)))
      entities.push(Object.freeze({
        name: table.name.slice(PLUGIN_TABLE_PREFIX.length),
        tableName: table.name,
        fields,
      }))
    }

    const indexes = Object.freeze([...this.indexes.values()].map(index => Object.freeze({
      name: index.name,
      tableName: index.tableName,
      columns: Object.freeze(index.columns.map(column => Object.freeze({
        name: column.name,
        direction: column.direction,
      }))),
      unique: index.unique,
      ...(index.predicate === undefined ? {} : { predicate: Object.freeze(index.predicate) }),
    })))

    return Object.freeze({
      tables: Object.freeze(tables),
      indexes,
      entities: Object.freeze(entities),
    })
  }

  private parseBegin (cursor: TokenCursor, token: Token): void {
    cursor.expectEnd()
    if (this.inTransaction) cursor.fail(token, '不支持嵌套 BEGIN。')
    this.inTransaction = true
    this.beginToken = token
    this.beginStatement = cursor.statement
  }

  private parseCommit (cursor: TokenCursor, token: Token): void {
    cursor.expectEnd()
    if (!this.inTransaction) cursor.fail(token, 'COMMIT 没有对应的 BEGIN。')
    this.inTransaction = false
    this.beginToken = undefined
    this.beginStatement = undefined
  }

  private parseCreate (cursor: TokenCursor): void {
    if (cursor.consumeKeyword('TABLE') !== undefined) {
      this.parseCreateTable(cursor)
      return
    }

    const unique = cursor.consumeKeyword('UNIQUE') !== undefined
    if (cursor.consumeKeyword('INDEX') === undefined) {
      cursor.fail(cursor.peek(), unique
        ? 'CREATE UNIQUE 后必须是 INDEX。'
        : '只支持 CREATE TABLE 和 CREATE [UNIQUE] INDEX。')
    }
    this.parseCreateIndex(cursor, unique)
  }

  private parseCreateTable (cursor: TokenCursor): void {
    const ifNotExists = parseIfNotExists(cursor)
    const tableToken = cursor.expectIdentifier('表名')
    const tableName = identifier(tableToken)
    if (tableName.startsWith(PLUGIN_TABLE_PREFIX)
      && !isLogicalEntityName(tableName.slice(PLUGIN_TABLE_PREFIX.length))) {
      cursor.fail(tableToken, `插件表 ${JSON.stringify(tableName)} 无法映射为合法的逻辑实体名。`)
    }

    cursor.expectSymbol('(')
    if (cursor.peekSymbol(')')) cursor.fail(cursor.peek(), 'CREATE TABLE 至少需要一个列定义。')

    const columns: MutableColumn[] = []
    while (true) {
      columns.push(this.parseColumn(cursor))
      if (cursor.consumeSymbol(',') === undefined) break
      if (cursor.peekSymbol(')')) cursor.fail(cursor.peek(), 'CREATE TABLE 不支持尾随逗号。')
    }
    cursor.expectSymbol(')')
    cursor.expectEnd()

    const existing = this.tables.get(tableName)
    if (existing !== undefined) {
      if (!ifNotExists) cursor.fail(tableToken, `表 ${JSON.stringify(tableName)} 已存在。`)
      return
    }

    const columnMap = new Map<string, MutableColumn>()
    for (const column of columns) {
      if (columnMap.has(column.name)) {
        cursor.fail(column.token, `列 ${JSON.stringify(column.name)} 被重复声明。`)
      }
      columnMap.set(column.name, column)
    }
    this.tables.set(tableName, {
      name: tableName,
      columns: columnMap,
    })
  }

  private parseAlter (cursor: TokenCursor): void {
    cursor.expectKeyword('TABLE')
    const tableToken = cursor.expectIdentifier('表名')
    const tableName = identifier(tableToken)
    const table = this.tables.get(tableName)
    if (table === undefined) cursor.fail(tableToken, `ALTER TABLE 引用了未知表 ${JSON.stringify(tableName)}。`)

    cursor.expectKeyword('ADD')
    cursor.expectKeyword('COLUMN')
    const ifNotExists = parseIfNotExists(cursor)
    const column = this.parseColumn(cursor)
    cursor.expectEnd()

    if (table.columns.has(column.name)) {
      if (!ifNotExists) cursor.fail(column.token, `列 ${JSON.stringify(column.name)} 已存在于 ${JSON.stringify(tableName)}。`)
      return
    }
    table.columns.set(column.name, column)
  }

  private parseCreateIndex (cursor: TokenCursor, unique: boolean): void {
    const ifNotExists = parseIfNotExists(cursor)
    const indexToken = cursor.expectIdentifier('索引名')
    const indexName = identifier(indexToken)
    cursor.expectKeyword('ON')
    const tableToken = cursor.expectIdentifier('表名')
    const tableName = identifier(tableToken)
    const columns = this.parseIndexColumns(cursor)
    const predicate = this.parseIndexPredicate(cursor)
    cursor.expectEnd()

    const existing = this.indexes.get(indexName)
    if (existing !== undefined) {
      if (!ifNotExists) cursor.fail(indexToken, `索引 ${JSON.stringify(indexName)} 已存在。`)
      return
    }

    const table = this.tables.get(tableName)
    if (table === undefined) cursor.fail(tableToken, `CREATE INDEX 引用了未知表 ${JSON.stringify(tableName)}。`)
    for (const column of columns) {
      if (!table.columns.has(column.name)) {
        cursor.fail(column.token, `索引 ${JSON.stringify(indexName)} 引用了 ${JSON.stringify(tableName)} 上未知的列 ${JSON.stringify(column.name)}。`)
      }
    }
    if (predicate !== undefined && !table.columns.has(predicate.column)) {
      cursor.fail(tableToken, `索引 ${JSON.stringify(indexName)} 的谓词引用了未知列 ${JSON.stringify(predicate.column)}。`)
    }

    this.indexes.set(indexName, {
      name: indexName,
      tableName,
      columns,
      unique,
      ...(predicate === undefined ? {} : { predicate }),
    })
  }

  private parseDrop (cursor: TokenCursor): void {
    cursor.expectKeyword('INDEX')
    const ifExists = parseIfExists(cursor)
    const indexToken = cursor.expectIdentifier('索引名')
    const indexName = identifier(indexToken)
    cursor.expectEnd()

    if (!this.indexes.has(indexName)) {
      if (!ifExists) cursor.fail(indexToken, `DROP INDEX 引用了未知索引 ${JSON.stringify(indexName)}。`)
      return
    }
    this.indexes.delete(indexName)
  }

  private parseColumn (cursor: TokenCursor): MutableColumn {
    const columnToken = cursor.expectIdentifier('列名')
    const name = identifier(columnToken)
    const typeToken = cursor.expectWord('列类型')
    const sqlType = parseSqlType(typeToken, cursor)
    let primaryKey = false
    let unique = false
    let nullability: 'unspecified' | 'null' | 'not-null' = 'unspecified'
    let references = false

    while (true) {
      const primary = cursor.consumeKeyword('PRIMARY')
      if (primary !== undefined) {
        cursor.expectKeyword('KEY')
        if (primaryKey) cursor.fail(primary, `列 ${JSON.stringify(name)} 重复声明 PRIMARY KEY。`)
        primaryKey = true
        unique = true
        continue
      }

      const not = cursor.consumeKeyword('NOT')
      if (not !== undefined) {
        cursor.expectKeyword('NULL')
        if (nullability !== 'unspecified') cursor.fail(not, `列 ${JSON.stringify(name)} 重复声明 NULL 约束。`)
        nullability = 'not-null'
        continue
      }

      const nullable = cursor.consumeKeyword('NULL')
      if (nullable !== undefined) {
        if (nullability !== 'unspecified') cursor.fail(nullable, `列 ${JSON.stringify(name)} 重复声明 NULL 约束。`)
        nullability = 'null'
        continue
      }

      const uniqueToken = cursor.consumeKeyword('UNIQUE')
      if (uniqueToken !== undefined) {
        if (unique) cursor.fail(uniqueToken, `列 ${JSON.stringify(name)} 重复声明 UNIQUE。`)
        unique = true
        continue
      }

      const referencesToken = cursor.consumeKeyword('REFERENCES')
      if (referencesToken !== undefined) {
        if (references) cursor.fail(referencesToken, `列 ${JSON.stringify(name)} 重复声明 REFERENCES。`)
        cursor.expectIdentifier('被引用的表名')
        cursor.expectSymbol('(')
        cursor.expectIdentifier('被引用的列名')
        cursor.expectSymbol(')')
        cursor.expectKeyword('ON')
        cursor.expectKeyword('DELETE')
        cursor.expectKeyword('CASCADE')
        references = true
        continue
      }
      break
    }

    const next = cursor.peek()
    if (next !== undefined && !cursor.peekSymbol(',') && !cursor.peekSymbol(')')) {
      cursor.fail(next, `列 ${JSON.stringify(name)} 不支持 ${JSON.stringify(next.text)} 约束。`)
    }

    return { name, sqlType, primaryKey, unique, token: columnToken }
  }

  private parseIndexColumns (cursor: TokenCursor): readonly MutableIndexColumn[] {
    cursor.expectSymbol('(')
    if (cursor.peekSymbol(')')) cursor.fail(cursor.peek(), 'CREATE INDEX 至少需要一个列。')

    const columns: MutableIndexColumn[] = []
    while (true) {
      const columnToken = cursor.expectIdentifier('索引列')
      let direction: 'ASC' | 'DESC' = 'ASC'
      if (cursor.consumeKeyword('ASC') !== undefined) direction = 'ASC'
      else if (cursor.consumeKeyword('DESC') !== undefined) direction = 'DESC'
      columns.push({ name: identifier(columnToken), direction, token: columnToken })

      if (cursor.consumeSymbol(',') === undefined) break
      if (cursor.peekSymbol(')')) cursor.fail(cursor.peek(), 'CREATE INDEX 不支持尾随逗号。')
    }
    cursor.expectSymbol(')')
    return columns
  }

  private parseIndexPredicate (cursor: TokenCursor): SchemaIndexPredicateFact | undefined {
    if (cursor.consumeKeyword('WHERE') === undefined) return undefined
    const column = identifier(cursor.expectIdentifier('谓词列'))
    cursor.expectKeyword('IS')
    cursor.expectKeyword('NOT')
    cursor.expectKeyword('NULL')
    return { column, kind: 'is-not-null' }
  }
}

class TokenCursor {
  private index = 0

  constructor (
    private readonly tokens: readonly Token[],
    private readonly file: string,
    readonly statement: number,
  ) {}

  peek (): Token | undefined {
    return this.tokens[this.index]
  }

  peekSymbol (symbol: string): boolean {
    const token = this.peek()
    return token?.kind === 'symbol' && token.text === symbol
  }

  consumeKeyword (expected: string): Token | undefined {
    const token = this.peek()
    if (token === undefined || keyword(token) !== expected) return undefined
    this.index += 1
    return token
  }

  consumeSymbol (expected: string): Token | undefined {
    const token = this.peek()
    if (token?.kind !== 'symbol' || token.text !== expected) return undefined
    this.index += 1
    return token
  }

  expectWord (description: string): Token {
    const token = this.take()
    if (token?.kind === 'word') return token
    this.fail(token, `期望 ${description}，实际为 ${describeToken(token)}。`)
  }

  expectIdentifier (description: string): Token {
    return this.expectWord(description)
  }

  expectKeyword (expected: string): Token {
    const token = this.take()
    if (token !== undefined && keyword(token) === expected) return token
    this.fail(token, `期望关键字 ${expected}，实际为 ${describeToken(token)}。`)
  }

  expectSymbol (expected: string): Token {
    const token = this.take()
    if (token?.kind === 'symbol' && token.text === expected) return token
    this.fail(token, `期望 ${JSON.stringify(expected)}，实际为 ${describeToken(token)}。`)
  }

  expectEnd (): void {
    const token = this.peek()
    if (token !== undefined) this.fail(token, `语句结尾存在未识别的标记 ${JSON.stringify(token.text)}。`)
  }

  fail (token: Token | undefined, message: string): never {
    throwInvalid(this.file, token ?? this.tokens[this.tokens.length - 1]!, message, this.statement)
  }

  private take (): Token | undefined {
    const token = this.tokens[this.index]
    if (token !== undefined) this.index += 1
    return token
  }
}

function parseIfNotExists (cursor: TokenCursor): boolean {
  if (cursor.consumeKeyword('IF') === undefined) return false
  cursor.expectKeyword('NOT')
  cursor.expectKeyword('EXISTS')
  return true
}

function parseIfExists (cursor: TokenCursor): boolean {
  if (cursor.consumeKeyword('IF') === undefined) return false
  cursor.expectKeyword('EXISTS')
  return true
}

function parseSqlType (token: Token, cursor: TokenCursor): SchemaSqlType {
  const type = keyword(token)
  if (SCHEMA_SQL_TYPES.includes(type as SchemaSqlType)) return type as SchemaSqlType
  cursor.fail(token, `不支持 SQL 类型 ${JSON.stringify(token.text)}；当前只支持 TEXT 和 TIMESTAMPTZ。`)
}

function splitTopLevelStatements (tokens: readonly Token[], file: string): readonly (readonly Token[])[] {
  const statements: Token[][] = []
  let current: Token[] = []
  let depth = 0
  let openParenthesis: Token | undefined

  for (const token of tokens) {
    if (token.kind === 'symbol' && token.text === '(') {
      depth += 1
      openParenthesis = token
      current.push(token)
      continue
    }
    if (token.kind === 'symbol' && token.text === ')') {
      depth -= 1
      if (depth < 0) throwInvalid(file, token, '右括号没有对应的左括号。')
      current.push(token)
      continue
    }
    if (token.kind === 'symbol' && token.text === ';' && depth === 0) {
      if (current.length > 0) statements.push(current)
      current = []
      continue
    }
    current.push(token)
  }

  if (depth !== 0) {
    throwInvalid(file, openParenthesis!, '左括号没有对应的右括号。')
  }
  if (current.length > 0) statements.push(current)
  return statements
}

function tokenize (source: string, file: string): readonly Token[] {
  const tokens: Token[] = []
  let index = 0
  let line = 1
  let column = 1

  const advance = (): string => {
    const character = source[index]!
    index += 1
    if (character === '\n') {
      line += 1
      column = 1
    } else {
      column += 1
    }
    return character
  }

  while (index < source.length) {
    const character = source[index]!
    if (isWhitespace(character)) {
      advance()
      continue
    }
    if (character === '-' && source[index + 1] === '-') {
      advance()
      advance()
      while (index < source.length && source[index] !== '\n') advance()
      continue
    }

    const tokenLine = line
    const tokenColumn = column
    if (isIdentifierStart(character)) {
      let text = ''
      while (index < source.length && isIdentifierPart(source[index]!)) text += advance()
      tokens.push({ kind: 'word', text, line: tokenLine, column: tokenColumn })
      continue
    }
    if (character === '\'' || character === '"') {
      let text = advance()
      let closed = false
      while (index < source.length) {
        const literalCharacter = advance()
        text += literalCharacter
        if (literalCharacter === '\\' && index < source.length) {
          text += advance()
          continue
        }
        if (literalCharacter !== character) continue
        if (source[index] === character) {
          text += advance()
          continue
        }
        closed = true
        break
      }
      if (!closed) {
        throwInvalid(file, { kind: 'literal', text, line: tokenLine, column: tokenColumn }, '引号字面量未闭合。')
      }
      tokens.push({ kind: 'literal', text, line: tokenLine, column: tokenColumn })
      continue
    }
    tokens.push({ kind: 'symbol', text: advance(), line: tokenLine, column: tokenColumn })
  }

  return tokens
}

function isWhitespace (character: string): boolean {
  return character === ' ' || character === '\t' || character === '\n' || character === '\r' || character === '\f'
}

function isIdentifierStart (character: string): boolean {
  const code = character.charCodeAt(0)
  return character === '_' || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}

function isIdentifierPart (character: string): boolean {
  const code = character.charCodeAt(0)
  return isIdentifierStart(character) || (code >= 48 && code <= 57)
}

function isLogicalEntityName (name: string): boolean {
  if (name.length === 0) return false
  const first = name.charCodeAt(0)
  if (first < 97 || first > 122) return false
  for (const character of name) {
    const code = character.charCodeAt(0)
    if (character !== '_' && !(code >= 97 && code <= 122) && !(code >= 48 && code <= 57)) return false
  }
  return true
}

function keyword (token: Token): string | undefined {
  return token.kind === 'word' ? token.text.toUpperCase() : undefined
}

function identifier (token: Token): string {
  return token.text.toLowerCase()
}

function describeToken (token: Token | undefined): string {
  return token === undefined ? '语句结尾' : JSON.stringify(token.text)
}

function throwInvalid (
  file: string,
  token: Token,
  message: string,
  statement?: number,
): never {
  throw new SchemaFactsError([{
    code: 'FH2_SCHEMA_SQL_INVALID',
    file,
    line: token.line,
    column: token.column,
    ...(statement === undefined ? {} : { statement }),
    message,
  }])
}

function formatDiagnostic (diagnostic: SchemaFactsDiagnostic): string {
  const statement = diagnostic.statement === undefined ? '' : ` 第 ${diagnostic.statement} 条语句`
  return `${diagnostic.file}:${diagnostic.line}:${diagnostic.column}${statement} ${diagnostic.code}: ${diagnostic.message}`
}

function errorMessage (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
