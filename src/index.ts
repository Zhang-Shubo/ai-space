export function greet(name: string): string {
  return `Hello, ${name}!`;
}

if (import.meta.main) {
  console.log(greet("ai-space"));
}
