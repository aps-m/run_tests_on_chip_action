import { execFileSync } from 'node:child_process'

function checkDependency(script: string): void {
  execFileSync(
    process.execPath,
    [
      '--max-old-space-size=128',
      '-e',
      `
        const assert = require('node:assert/strict')
        const { createRequire } = require('node:module')
        const parserRequire = createRequire(
          require.resolve('@typescript-eslint/typescript-estree')
        )
        const matching = parserRequire('minimatch')
        ${script}
      `
    ],
    { cwd: process.cwd(), timeout: 10000, stdio: 'pipe' }
  )
}

describe('development dependency compatibility and security', () => {
  it('bounds minimatch preprocessing without changing ordinary matches', () => {
    expect(() =>
      checkDependency(`
      const pattern = Array(8).fill('**/../a/b').join('/')
      const bounded = new matching.Minimatch(pattern, {
        optimizationLevel: 2,
        braceExpandMax: 64
      })
      assert.equal(bounded.set.length, 64)
      const large = new matching.Minimatch('{x,*}/{0..999}', {
        optimizationLevel: 2
      })
      assert.equal(large.set.length, 2000)
      assert.equal(large.match('x/5'), true)
      assert.equal(large.match('y/999'), true)
      assert.equal(large.match('.y/5'), false)
      const ordinary = new matching.Minimatch('**/../a/b/**/../c/d', {
        optimizationLevel: 2
      })
      assert.equal(ordinary.match('../a/b/../c/d'), true)
      assert.equal(ordinary.match('x/a/b/y/c/d'), true)
    `)
    ).not.toThrow()
  })

  it('preserves the parser project-service allowlist and rejection', () => {
    expect(() =>
      checkDependency(`
      const parser = require('@typescript-eslint/parser')
      const ts = require('typescript')
      const path = require('node:path')
      const os = require('node:os')
      const filePath = path.join(os.tmpdir(), 'aps-minimatch-compat-input.ts')
      const original = matching.minimatch
      let calls = 0
      matching.minimatch = (...args) => {
        calls++
        return original(...args)
      }
      const parse = pattern => parser.parseForESLint('const value: number = 1', {
        filePath,
        programs: [ts.createProgram([], {})],
        tsconfigRootDir: process.cwd(),
        EXPERIMENTAL_useProjectService: {
          allowDefaultProjectForFiles: [pattern]
        }
      })
      try {
        assert.ok(parse(filePath.replaceAll('\\\\', '/')).services.program)
        assert.equal(calls, 1)
        parser.clearCaches()
        assert.throws(() => parse('never-matches.ts'), /not found by the project service/)
        assert.equal(calls, 2)
      } finally {
        matching.minimatch = original
        parser.clearCaches()
      }
    `)
    ).not.toThrow()
  })

  it('preserves the legacy matcher API used by ESLint and Jest', () => {
    expect(() =>
      checkDependency(`
      const eslintRequire = createRequire(require.resolve('eslint'))
      const jestRequire = createRequire(require.resolve('@jest/reporters'))
      const legacy = eslintRequire('minimatch')
      const glob = jestRequire('glob')
      const path = require('node:path')
      assert.equal(typeof legacy, 'function')
      assert.equal(legacy.makeRe('src/*.ts').test('src/main.ts'), true)
      assert.equal(legacy(
        path.join(process.cwd(), 'src', 'main.ts'),
        path.join(process.cwd(), 'src', '**')
      ), true)
      assert.ok(glob.sync('src/**/*.ts').includes('src/main.ts'))
    `)
    ).not.toThrow()
  })
})
