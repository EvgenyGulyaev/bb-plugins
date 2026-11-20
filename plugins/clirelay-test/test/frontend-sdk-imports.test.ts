// Фронт-бандл при git-установке собирается без devDependencies, поэтому
// серверный `@get-bb/plugin-sdk` (devDependency) в нём не разрешается.
// Разрешён только рантайм-шим `@get-bb/plugin-sdk/app`.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverSdk = "@get-bb/plugin-sdk";

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    return entry.isDirectory() ? tsxFiles(path) : entry.name.endsWith(".tsx") ? [path] : [];
  });
}

function resolveLocalImport(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".") && !specifier.startsWith("@/")) return null;
  const base = specifier.startsWith("@/")
    ? resolve(root, specifier.slice(2))
    : resolve(dirname(fromFile), specifier);
  const candidates = extname(base) ? [base] : [`${base}.ts`, `${base}.tsx`, resolve(base, "index.ts"), resolve(base, "index.tsx")];
  return candidates.find((path) => existsSync(path) && statSync(path).isFile()) ?? null;
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

/**
 * Спецификатор модуля, если statement тянет его в рантайме. `import type`,
 * inline `type`-спецификаторы и `export type ... from` стираются сборщиком.
 */
function runtimeSpecifier(statement: ts.Statement): string | null {
  if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
    const clause = statement.importClause;
    if (clause === undefined) return statement.moduleSpecifier.text;
    if (clause.isTypeOnly) return null;
    const named = clause.namedBindings;
    const hasValueBinding =
      clause.name !== undefined ||
      named === undefined ||
      (ts.isNamedImports(named) ? named.elements.some((element) => !element.isTypeOnly) : true);
    return hasValueBinding ? statement.moduleSpecifier.text : null;
  }
  if (ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier)) {
    if (statement.isTypeOnly) return null;
    const clause = statement.exportClause;
    const hasValueBinding =
      clause === undefined ||
      (ts.isNamedExports(clause) ? clause.elements.some((element) => !element.isTypeOnly) : true);
    return hasValueBinding ? statement.moduleSpecifier.text : null;
  }
  return null;
}

function runtimeSpecifiersOf(source: string): string[] {
  const file = ts.createSourceFile("sample.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return file.statements.map(runtimeSpecifier).filter((specifier): specifier is string => specifier !== null);
}

/** Модули, реально попадающие в frontend bundle: старт — app.tsx и components/**. */
function frontendRuntimeModules(): string[] {
  const pending = [resolve(root, "app.tsx"), ...tsxFiles(resolve(root, "components"))];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    for (const statement of parse(file).statements) {
      const specifier = runtimeSpecifier(statement);
      const local = specifier === null ? null : resolveLocalImport(file, specifier);
      if (local !== null) pending.push(local);
    }
  }
  return [...visited];
}

describe("frontend SDK boundary", () => {
  it("различает type-импорт, value-импорт и рантайм-шим", () => {
    expect(runtimeSpecifiersOf('import type { A } from "@get-bb/plugin-sdk";')).toEqual([]);
    expect(runtimeSpecifiersOf('import { type A } from "@get-bb/plugin-sdk";')).toEqual([]);
    expect(runtimeSpecifiersOf('export type { A } from "@get-bb/plugin-sdk";')).toEqual([]);
    expect(runtimeSpecifiersOf('import { defineRpcContract } from "@get-bb/plugin-sdk";')).toEqual([serverSdk]);
    expect(runtimeSpecifiersOf('import { useRpc } from "@get-bb/plugin-sdk/app";')).toEqual(["@get-bb/plugin-sdk/app"]);
  });

  it("доходит до транзитивных lib-модулей фронта", () => {
    const modules = frontendRuntimeModules().map((file) => relative(root, file));
    expect(modules).toEqual(expect.arrayContaining(["app.tsx", "lib/schema.ts", "lib/tokens/contract.ts"]));
  });

  it("не содержит value-import серверного SDK во frontend runtime graph", () => {
    const violations: string[] = [];
    for (const file of frontendRuntimeModules()) {
      const source = parse(file);
      for (const statement of source.statements) {
        if (runtimeSpecifier(statement) !== serverSdk) continue;
        const { line } = source.getLineAndCharacterOfPosition(statement.getStart(source));
        violations.push(`${relative(root, file)}:${line + 1}`);
      }
    }
    expect(violations).toEqual([]);
  });
});