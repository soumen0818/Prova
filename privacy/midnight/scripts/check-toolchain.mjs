import { execFileSync } from 'node:child_process';

const expected = {
  compiler: '0.31.1',
  language: '0.23.0',
  runtime: '0.16.0',
  ledger: 'ledger-8.0.2',
};

const compact = (flag) =>
  execFileSync('compact', ['compile', flag], { encoding: 'utf8' }).trim();

const actual = {
  compiler: compact('--version'),
  language: compact('--language-version'),
  runtime: compact('--runtime-version'),
  ledger: compact('--ledger-version'),
};

const mismatches = Object.entries(expected).filter(
  ([name, version]) => actual[name] !== version,
);

if (mismatches.length > 0) {
  const details = mismatches
    .map(([name, version]) => `  ${name}: expected ${version}, found ${actual[name]}`)
    .join('\n');
  console.error(
    `\nIncompatible Compact toolchain:\n${details}\n\n` +
      'Install and select the project compiler with:\n\n' +
      '  compact update 0.31.1\n',
  );
  process.exit(1);
}

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor !== 22) {
  console.warn(
    `Warning: Node ${process.versions.node} is active; Node 22 is the supported project version.`,
  );
}

console.log(
  `Compact ${actual.compiler} (language ${actual.language}, runtime ${actual.runtime}, ${actual.ledger})`,
);
