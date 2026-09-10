export const MINIMUM_NODE_VERSION = "22.13.0";

const parseVersion = (value: string): [number, number, number] | undefined => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
};

export const assertSupportedNodeVersion = (
  version: string,
  minimum = MINIMUM_NODE_VERSION,
) => {
  const parsed = parseVersion(version);
  const parsedMinimum = parseVersion(minimum);
  if (!parsed || !parsedMinimum) {
    throw new Error(`Cannot parse Node.js version ${JSON.stringify(version)}`);
  }
  let comparison = 0;
  for (let index = 0; index < parsed.length; index += 1) {
    comparison = parsed[index] - parsedMinimum[index];
    if (comparison !== 0) break;
  }
  if (comparison < 0) {
    throw new Error(
      `Premind requires Node.js ${minimum} or newer for stable node:sqlite support; found ${version.trim()}`,
    );
  }
};
