export class CostCeilingExceeded extends Error {
  constructor(public readonly spentUsd: number) {
    super(`projected spend $${spentUsd.toFixed(2)} exceeded the cost ceiling`);
  }
}

export type ModelPrice = { input: number; output: number }; // USD per 1M tokens

export function runCostTracker(ceilingUsd = Infinity): {
  add(usage: { input_tokens: number; output_tokens: number }, price: ModelPrice): void;
  spentUsd(): number;
} {
  let spent = 0;
  return {
    add(usage, price) {
      spent += (usage.input_tokens / 1_000_000) * price.input + (usage.output_tokens / 1_000_000) * price.output;
      if (spent > ceilingUsd) throw new CostCeilingExceeded(spent);
    },
    spentUsd: () => spent,
  };
}
