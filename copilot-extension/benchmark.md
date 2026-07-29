# Benchmark: Todo REST API with Express.js

## Task
Build a complete Express.js REST API (CRUD + in-memory store + input validation + CORS + supertest tests).

## Models Tested

| Model | Provider | Runs | Avg Time | Success Rate | Quality Score |
|-------|----------|------|----------|-------------|--------------|
| deepseek/deepseek-r1-0528-qwen3-8b | LM Studio | 5 | 127s | **20%** | ⭐⭐ |
| google/gemma-4-e4b | LM Studio | 4 | 135s | **100%** | ⭐⭐⭐⭐ |
| Jan-v3.5-4B-Q4_K_XL | JAN AI | 2 | 30s | **100%** | ⭐⭐⭐ |
| deepseek-r1:14b | Ollama | 2 | 539s | **100%** | ⭐⭐⭐ |
| gemma4:12b | Ollama | 2 | 361s | **100%** | ⭐⭐⭐⭐ |
| llama3.1:8b | Ollama | 2 | 31s | **100%** | ⭐⭐⭐ |
| qwen2.5-coder:3b | Ollama | 2 | 15s | **100%** | ⭐⭐ |
| qwen2.5-coder:14b | Ollama | 2 | 232s | **100%** | ⭐⭐⭐⭐ |
| qwen3.5:9b | Ollama | 6 | 102s | **0%** | — |

## Detailed Analysis

### 1. deepseek/deepseek-r1-0528-qwen3-8b (LM Studio) — 5 runs

| Run | Duration | Result |
|-----|----------|--------|
| 1 | 97.7s | ✅ Good - Generated complete code + tests with explanation text |
| 2 | 72.2s | ❌ FAIL - Returned JSON: `"cannot generate code"` refusal |
| 3 | 214.1s | ❌ FAIL - Returned `{"error": "Error: Missing title"}` |
| 4 | 9.5s | ❌ FAIL - Asked for file name clarification instead of generating code |
| 5 | 240.9s | ⚠️ Partial - Generated code but test file had broken mock setup |

**Verdict: Unstable.** 4/5 runs failed or produced broken output. Only Run 1 was fully usable. Wildly inconsistent response patterns — sometimes refuses, sometimes returns JSON errors, sometimes generates code. Not suitable for reliable code generation.

### 2. google/gemma-4-e4b (LM Studio) — 4 runs

| Run | Duration | Result |
|-----|----------|--------|
| 1 | 121.8s | ✅ Good - CJS (require/module.exports), `Map()` store, counter-based IDs, included `package.json`, proper validation, 204 on delete, `dYs?` typo in startup log |
| 2 | 153.6s | ✅ Excellent - ESM (import/export), Babel for Jest, `Math.random()` IDs, `clearStore()`, middleware/errorHandler.js, 204 on delete, thorough tests, `dYs?` typo |
| 3 | 153.6s | ✅ Good - Multifile modular (app.js, store.js, todoController.js, todoRoutes.js), counter-based IDs (`todo-${length+1}` — reuse bug on delete), factory `createApp()` pattern, 204 on delete, comprehensive tests |
| 4 | 110.4s | ✅ Good - Single file, uuidv4, proper validation with trim + 100-char limit, `?completed=true/false` filter, delete returns 200 with body, exposes `todosStore`, `dYs?` typo |

**Verdict: Stable and high quality.** 4/4 passes. Consistently produces clean code with proper error handling, validation, and test coverage. Typical `dYs?` startup log typo appears in some runs. Consistent ~2 min average. Most production-ready output across all models tested.

### 3. Jan-v3.5-4B-Q4_K_XL (JAN AI) — 2 runs

| Run | Duration | Result |
|-----|----------|--------|
| 1 | 28.5s | ✅ Good - CJS (require/module.exports), proper validation, good test coverage |
| 2 | 30.5s | ⚠️ Bug - ESM import syntax but `todos[todo` spread was broken (syntax error in update route) |

**Verdict: Fast but limited.** Fastest model by far (~30s vs 150s+). Run 1 was solid. Run 2 had a code bug. The 4B parameter limit shows in code quality variance. Good for quick drafts but needs review.

### 4. deepseek-r1:14b (Ollama) — 2 runs

| Run | Duration | Tokens | tok/s | Result |
|-----|----------|--------|-------|--------|
| 1 | 621.2s | 1834 | 3.0 | ✅ OK - Used express-validator, mounted under `/api` prefix, reasonable tests |
| 2 | 457.8s | 1350 | 3.0 | ⚠️ Weaker - Shorter output, test file was a template with `// ... other test cases`, included `[CMD]` blocks |

**Verdict: Very slow.** ~8-10 minutes per run. Run 1 was reasonable quality but deviated from spec (used `/api` prefix, added express-validator dependency). Run 2 was weaker with incomplete tests. Consistent at 3 tok/s.

### 5. gemma4:12b (Ollama) — 2 runs

| Run | Duration | Tokens | tok/s | Result |
|-----|----------|--------|-------|--------|
| 1 | 350.5s | 2854 | 8.1 | ✅ Good - CJS, uuid IDs, proper validation, complete tests (chai + supertest). Minor: stray `app.delete('/1',...)` placeholder. |
| 2 | 371.8s | 3093 | 8.3 | ✅ Good - Better organized with `findTodoById` helper + `validateTodo` middleware. Solid tests with full coverage. Minor: one truncated test line in PUT validation test. |

**Verdict: Solid mid-range.** Twice as fast as deepseek-r1:14b (6 min vs 9+ min) at 8 tok/s. Consistent output across both runs — clean CJS code with uuid, proper validation, and good test coverage. Minor glitches in each run but functionally complete. Quality comparable to gemma-4-e4b but in CJS format.

### 6. llama3.1:8b (Ollama) — 2 runs

| Run | Duration | Tokens | tok/s | Result |
|-----|----------|--------|-------|--------|
| 1 | 33.2s | 1639 | 49 | ✅ Good - CJS, separated files (todo.js, store.js, app.js, test.js), proper validation with manual CORS headers |
| 2 | 28.6s | 1382 | 48 | ✅ Good - ESM (import/export), uuid IDs, concise server + test file |

**Verdict: Fast and consistent.** ~30s average at 48 tok/s. Both runs produced working code. Format fluctuates between CJS and ESM between runs. Quality is decent for the speed — good for quick iterations.

### 7. qwen2.5-coder:3b (Ollama) — 2 runs

| Run | Duration | Tokens | tok/s | Result |
|-----|----------|--------|-------|--------|
| 1 | 13.8s | 1273 | 92 | ✅ OK - CJS, proper CORS + validation. Weak: used `todos.length + 1` for IDs (fragile). |
| 2 | 15.3s | 1349 | 88 | ⚠️ Hallucinated - Imported `mongoose`, `express-validator`, `dotenv` but never used them. `body()` referenced without import. Commented-out MongoDB code. |

**Verdict: Fastest model at 90 tok/s but unreliable.** 3B parameter limit shows — second run hallucinated extra dependencies and included dead code. ID generation using array length is a bug. Good for speed, always review output.

### 8. qwen2.5-coder:14b (Ollama) — 2 runs

| Run | Duration | Tokens | tok/s | Result |
|-----|----------|--------|-------|--------|
| 1 | 234.1s | 1343 | 6 | ✅ Good - CJS, uuid IDs, proper validation, 204 on delete, comprehensive tests covering all endpoints + error cases |
| 2 | 230.2s | 1365 | 6 | ✅ Good - Similar quality, try/catch wrapping, spread for updates. Minor: delete returned 200 with body instead of 204 |

**Verdict: Consistent and clean.** ~4 min average at 6 tok/s. Both runs produced clean, correct CJS code with uuid IDs, proper validation, and thorough test coverage. Quality comparable to gemma4:12b but slower (4 min vs 6 min for gemma4:12b — actually faster). Good middle-ground option.

### 9. qwen3.5:9b (Ollama) — 5 runs

| Run | Duration | Tokens | Result |
|-----|----------|--------|--------|
| 1 | 54.3s | 2129 | ❌ FAIL - Syntax errors: `res.json(count: ...)`, `express.json()` instead of `express()`. Tests broken (missing parens) |
| 2 | 23.6s | 893 | ❌ FAIL - Very short (893 tok). Code incomplete with weird custom regex validation. Tests never materialized |
| 3 | 91.0s | 3463 | ❌ FAIL - Model entered self-correction loop. Output contains meta-commentary: *"I've been creating fragments... Let me provide clean files"*. Multiple broken function redefinitions |
| 4 | 36.2s | 1332 | ❌ FAIL - Completely broken: `let nextId = 2: todos[i] => t.id === id)` (invalid JS), variables used before definition, unreachable code |
| 5 | 96.7s | 3632 | ❌ FAIL - Worst run yet. Model entered extreme self-correction spiral: redefined `getAllTodos` ~15 times, each more convoluted. Scattered `throw new Error('Invalid format')` randomly. 16× function redefinitions for a simple filter |
| 6 | 312.7s | — | ❌ FAIL - Complete breakdown. Class with undefined methods (`#normalizeTitle`), `timestampToDateFn` spread as object, invalid syntax `[express()]]`. Then devolves into listing every country on Earth (repetitive country list fills rest of output) |

**Verdict: 0% success rate across 6 runs — unusable.** Massive fluctuation in output length. Model consistently enters "spiral of death" — starts generating, detects its own errors, tries to correct by writing new inline code, producing increasingly broken output. Run 5 set a record for self-correction spiraling (3632 tokens). Run 6 broke down entirely, outputting a country list instead of working code. Despite being 9B, it performed worse than all 3B-4B models. This may be a quantization or provider issue.

## Stability Comparison

```
qwen3.5:9b                  ░░░░░░░░░░   0% success (0/6 usable)
deepseek-r1-0528-qwen3-8b   ██░░░░░░░░  20% success (1/5 usable)
deepseek-r1:14b              ██████░░░░  50% good (1/2 good, 1/2 weak)
Jan-v3.5-4B-Q4_K_XL         ██████░░░░  60% perfect (1/2 perfect, 1/2 buggy)
qwen2.5-coder:3b            ██████░░░░  50% clean (1/2 clean, 1/2 hallucinated deps)
llama3.1:8b                 ██████████ 100% success (2/2 good)
qwen2.5-coder:14b           ██████████ 100% success (2/2 good)
google/gemma-4-e4b          ██████████ 100% success (4/4 good-excellent)
gemma4:12b                  ██████████ 100% success (2/2 good)
```

## Performance Chart

```
qwen2.5-coder:3b           15s  ██
llama3.1:8b                31s  ████
Jan-v3.5-4B-Q4_K_XL        30s  ████
qwen3.5:9b                102s  ██████████████
deepseek-r1-0528-qwen3-8b 127s  █████████████████
google/gemma-4-e4b        135s  █████████████████
qwen2.5-coder:14b         232s  ████████████████████████████████
gemma4:12b               361s  █████████████████████████████████████████████████
deepseek-r1:14b           539s  ████████████████████████████████████████████████████████
```

## Recommendations

1. **For reliable production code** → **google/gemma-4-e4b**. 4/4 passes (100% stable), consistently clean code with proper validation and test coverage. ~2 min average.

2. **For fastest iteration** → **llama3.1:8b** (31s, 48 tok/s, 100% success) — beats Jan-4B on both speed and consistency. **qwen2.5-coder:3b** (15s!) is even faster but prone to hallucinating dependencies.

3. **Mid-range workhorse** → **qwen2.5-coder:14b** (4 min, 6 tok/s) and **gemma4:12b** (6 min, 8 tok/s). Both produce consistently clean code with proper validation and tests.

4. **Not recommended**:
   - **qwen3.5:9b** — 0% success rate across 6 runs. Model enters self-correction death spiral or outputs country lists.
   - **deepseek-r1-0528-qwen3-8b** — 80% failure rate, wildly inconsistent.
   - **deepseek-r1:14b** — too slow at 9+ min average.
