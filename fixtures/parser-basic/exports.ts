export function publicFn(): number {
  return 1;
}

function privateFn(): number {
  return 2;
}

export const publicArrow = (): number => 3;

const privateArrow = (): number => 4;

export class PublicClass {
  method(): void {
    privateFn();
  }
}

class PrivateClass {
  run(): void {}
}
