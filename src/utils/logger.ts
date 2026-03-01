// ============================================================
// Simple coloured logger
// ============================================================

const C = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

export const logger = {
  info(msg: string, ...args: unknown[]) {
    console.log(`${C.blue}[INFO]${C.reset} ${msg}`, ...args);
  },
  success(msg: string, ...args: unknown[]) {
    console.log(`${C.green}[OK]${C.reset} ${msg}`, ...args);
  },
  warn(msg: string, ...args: unknown[]) {
    console.warn(`${C.yellow}[WARN]${C.reset} ${msg}`, ...args);
  },
  error(msg: string, ...args: unknown[]) {
    console.error(`${C.red}[ERROR]${C.reset} ${msg}`, ...args);
  },
  debug(msg: string, ...args: unknown[]) {
    if (process.env.DEBUG) {
      console.log(`${C.gray}[DEBUG]${C.reset} ${msg}`, ...args);
    }
  },
  step(step: number, total: number, msg: string) {
    console.log(`${C.cyan}[${step}/${total}]${C.reset} ${msg}`);
  },
};
