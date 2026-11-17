// Compiles SpurPit.sol with solc 0.8.24 (optimizer 200, viaIR, cancun) into build/SpurPit.json,
// SpurPit.standard-input.json (for Sourcify exact_match verification), and deploy.html.
import solc from 'solc';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const source = readFileSync(new URL('./SpurPit.sol', import.meta.url), 'utf8');
const input = {
  language: 'Solidity',
  sources: { 'SpurPit.sol': { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    viaIR: true,
    evmVersion: 'cancun',
    outputSelection: {
      '*': {
        '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.methodIdentifiers'],
      },
    },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input)));
for (const e of out.errors || []) console.log(e.severity, e.formattedMessage);
if ((out.errors || []).some((e) => e.severity === 'error')) process.exit(1);

const c = out.contracts['SpurPit.sol'].SpurPit;
const bytecode = '0x' + c.evm.bytecode.object;
const stdInput = {
  ...input,
  settings: {
    ...input.settings,
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'metadata'] } },
  },
};

mkdirSync(new URL('./build/', import.meta.url), { recursive: true });
writeFileSync(
  new URL('./build/SpurPit.json', import.meta.url),
  JSON.stringify({ abi: c.abi, bytecode, selectors: c.evm.methodIdentifiers }, null, 2),
);
writeFileSync(new URL('./SpurPit.standard-input.json', import.meta.url), JSON.stringify(stdInput, null, 2));

const tpl = readFileSync(new URL('./deploy.template.html', import.meta.url), 'utf8');
const bindSel = c.evm.methodIdentifiers['bindSpur(address)'];
const html = tpl
  .replace('__BYTECODE__', JSON.stringify(bytecode))
  .replace('__STD_JSON__', JSON.stringify(stdInput))
  .replace('__BIND_SEL__', JSON.stringify(bindSel));
writeFileSync(new URL('./deploy.html', import.meta.url), html);

console.log('compiled SpurPit, runtime', c.evm.deployedBytecode.object.length / 2, 'bytes; wrote deploy.html');
