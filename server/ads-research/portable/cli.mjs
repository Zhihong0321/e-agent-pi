#!/usr/bin/env node
import { analyze, applyFilter, collect, loadTopic, openStore, report, status } from './index.mjs';

const args = argv => {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[key] = argv[++i];
      else out[key] = true;
    } else out._.push(a);
  }
  return out;
};

const a = args(process.argv.slice(2));
const command = a._[0] || 'status';
const topic = a.topic || 'my-solar';
const log = (...parts) => console.error(...parts);

try {
  loadTopic(topic);
  if (command === 'status') {
    console.log(JSON.stringify(status(topic), null, 2));
  } else if (command === 'collect') {
    console.log(JSON.stringify(await collect(topic, { log }), null, 2));
  } else if (command === 'filter') {
    const store = openStore(topic);
    try { console.log(JSON.stringify(applyFilter(store, loadTopic(topic)), null, 2)); }
    finally { store.close(); }
  } else if (command === 'analyze') {
    console.log(JSON.stringify(await analyze(topic, { limit: Number(a.limit) || 0, log }), null, 2));
  } else if (command === 'report') {
    console.log(JSON.stringify(await report(topic, { lang: a.lang || 'en', archive: a.archive !== 'false' }), null, 2));
  } else if (command === 'run') {
    const collection = await collect(topic, { log });
    const analysis = a.analyze === 'false' ? null : await analyze(topic, { limit: Number(a.limit) || 0, log });
    const rendered = await report(topic, { lang: a.lang || 'en', archive: a.archive !== 'false' });
    console.log(JSON.stringify({ collection, analysis, report: rendered }, null, 2));
  } else {
    throw new Error(`unknown command: ${command}; use collect, filter, analyze, report, run, or status`);
  }
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
