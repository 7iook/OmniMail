import { describe, expect, it } from 'vitest'
import {
  chargedCall,
  createReconcileBudget,
  ReconcileBudgetExhaustedError,
  rethrowIfBudgetExhausted,
} from './microsoft-graph-reconcile-budget'

describe('microsoft-graph-reconcile-budget (re-review Important #3)', () => {
  it('charges exactly one unit of capacity per chargedCall, not per row/account', async () => {
    const budget = createReconcileBudget(() => 0, 20_000, 3)
    await chargedCall(budget, async () => 'a')
    await chargedCall(budget, async () => 'b')
    await chargedCall(budget, async () => 'c')

    await expect(chargedCall(budget, async () => 'd')).rejects.toBeInstanceOf(ReconcileBudgetExhaustedError)
  })

  it('stops granting capacity once the wall-clock deadline has passed, independent of the call cap', async () => {
    let elapsedMs = 0
    const nowMs = () => { const value = elapsedMs; elapsedMs += 15_000; return value }
    const budget = createReconcileBudget(nowMs, 20_000, 1_000)

    await chargedCall(budget, async () => 1) // 0ms: within deadline
    await expect(chargedCall(budget, async () => 2)).rejects.toBeInstanceOf(ReconcileBudgetExhaustedError)
  })

  it('does not spend capacity or run the call when the budget is already exhausted', async () => {
    const budget = createReconcileBudget(() => 0, 20_000, 1)
    let ran = 0
    await chargedCall(budget, async () => { ran += 1 })

    await expect(chargedCall(budget, async () => { ran += 1 })).rejects.toBeInstanceOf(ReconcileBudgetExhaustedError)
    expect(ran).toBe(1)
  })

  it('rethrowIfBudgetExhausted rethrows the sentinel and swallows nothing else', () => {
    expect(() => rethrowIfBudgetExhausted(new ReconcileBudgetExhaustedError())).toThrow(ReconcileBudgetExhaustedError)
    expect(() => rethrowIfBudgetExhausted(new Error('some other failure'))).not.toThrow()
    expect(() => rethrowIfBudgetExhausted({ status: 403 })).not.toThrow()
  })
})
