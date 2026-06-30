import { helper } from "./helper";

export function doWork(x: number): number {
  return helper(x) + 1;
}

export class Worker {
  run(): void {
    doWork(1);
  }
}
