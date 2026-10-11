// Tiny dependency-free CLI arg parser shared by every script.
// --key value / --flag -> { _: [positionals], key: value, flag: true }
// Repeated keys collect into an array.
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      const value = next !== undefined && !next.startsWith("--") ? (i++, next) : true;
      if (key in out) out[key] = [].concat(out[key], value);
      else out[key] = value;
    } else {
      out._.push(arg);
    }
  }
  return out;
}
