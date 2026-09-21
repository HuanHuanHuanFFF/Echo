"""Official QASPER F1 + strict returned-line coverage on the frozen small pilot."""
import sys,json,pathlib,hashlib,importlib.util,importlib.metadata,statistics,collections,math,datetime
root=pathlib.Path(sys.argv[1]).resolve();out=pathlib.Path(sys.argv[2]).resolve()
assert out.is_relative_to(root) and out!=root and not (out/'summary.json').exists()
sys.path.insert(0,str(root/'scoring-tools'))
import numpy as np
def rows(p):
 with open(p,encoding='utf8') as f:return [json.loads(l) for l in f if l.strip()]
def read(p):return json.loads(p.read_text(encoding='utf8'))
def sha(p):
 with open(p,'rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def write(name,x):
 with open(out/name,'x',encoding='utf8') as f:json.dump(x,f,ensure_ascii=False,indent=2);f.write('\n')
def rel(p):return str(p.relative_to(root)).replace(chr(92),'/')
plan=read(out/'freeze.json');receipt=read(out/'run-receipt.json')
assert plan['weights']==[0,0.1,0.25,0.3,0.4,0.5]
assert receipt['calls']==606 and receipt['baseline_0_5_all_scores_and_evidence_equal']
for p,h in receipt['bindings'].items():assert sha(root/p)==h,p
assert receipt['index_sha256_before']==receipt['index_sha256_after']==sha(root/'qasper/structure.sqlite')
ids=plan['ids'];assert len(ids)==len(set(ids))==101
queries={q['id']:q for q in rows(root/'prepared/qasper-queries.jsonl')};assert set(ids)<=set(queries)
docs={d['id']:d for d in rows(root/'prepared/qasper-docs.jsonl')}
texts={p:pathlib.Path(docs[p]['file']).read_bytes().decode('utf8').split('\n') for p in {queries[q]['paper_id'] for q in ids}}
assert sum(queries[q]['eligible'] for q in ids)==plan['eligible']
spec=importlib.util.spec_from_file_location('qasper_official',root/'reference/qasper_evaluator.py')
official=importlib.util.module_from_spec(spec);spec.loader.exec_module(official)
papers={p['id']:p for p in rows(root/'data/qasper-dev.jsonl')}
gold_all=official.get_answers_and_evidence(papers,False)
gold={q:gold_all[q] for q in ids}
per={};conditions={};bindings={'freeze.json':sha(out/'freeze.json'),'run-receipt.json':sha(out/'run-receipt.json')}
for w in plan['weights']:
 label=str(w);file=out/f'w{w}-results.jsonl';data=rows(file)
 assert len(data)==101 and [r['id'] for r in data]==ids and all(r['bm25_weight']==w for r in data)
 metrics={};predictions={}
 for r in data:
  q=queries[r['id']];doc=docs[q['paper_id']];lines=texts[q['paper_id']];covered=set()
  assert r['paper_id']==q['paper_id']
  assert r['request']['filters']['source_ids']==[q['source_id']]
  assert r['request']['overrides']['mode']==('dense' if w==0 else 'hybrid')
  assert r['request']['overrides']['bm25_weight']==w
  assert r['request_chars']+r['response_chars']<=16000
  assert len(r['result']['results'])<=3
  for piece in r['result']['results']:
   assert piece['source_id']==q['source_id']==doc['source_id']
   start,end=piece['start_line'],piece['end_line']
   assert 1<=start<=end<=len(lines)
   assert '\n'.join(lines[start-1:end])==piece['text']
   covered.update(i for i in range(start,end+1) if lines[i-1].strip())
  full=[p for p in doc['paragraphs'] if all(i in covered for i in range(p['start_line'],p['end_line']+1) if lines[i-1].strip())]
  selected={p['id'] for p in full}
  assert [p['id'] for p in full]==r['score']['selected_paragraphs']
  valid=[a for a in q['annotations'] if a['valid']]
  coverage=max((sum(bool(selected.intersection(e['paragraph_ids'])) for e in a['evidence'])/len(a['evidence']) for a in valid),default=None)
  complete=any(all(bool(selected.intersection(e['paragraph_ids'])) for e in a['evidence']) for a in valid)
  assert complete==r['score']['strict_complete']
  assert coverage==r['score']['strict_coverage']
  evidence=[p['text'] for p in full];predictions[q['id']]={'answer':'','evidence':evidence}
  f1=max(official.paragraph_f1_score(evidence,a['evidence']) for a in gold[q['id']])
  assert math.isclose(f1,r['score']['official_formula_evidence_f1'],abs_tol=1e-12)
  metrics[q['id']]={'paper_id':q['paper_id'],'eligible':q['eligible'],'category':q['category'],'strict_complete':int(complete),'strict_coverage':coverage,'evidence_f1':f1,'context_chars':r['request_chars']+r['response_chars'],'returned_chunks':len(r['result']['results']),'selected_paragraphs':len(full)}
 score=official.evaluate(gold,predictions)
 assert score['Missing predictions']==0
 assert math.isclose(score['Evidence F1'],statistics.mean(m['evidence_f1'] for m in metrics.values()),abs_tol=1e-12)
 eligible=[m for m in metrics.values() if m['eligible']]
 conditions[label]={'questions':101,'eligible':len(eligible),'complete':sum(m['strict_complete'] for m in eligible),'complete_rate':statistics.mean(m['strict_complete'] for m in eligible),'strict_coverage':statistics.mean(m['strict_coverage'] for m in eligible),'official_evidence_f1_all':score['Evidence F1'],'mean_context_chars':statistics.mean(m['context_chars'] for m in metrics.values()),'mean_chunks':statistics.mean(m['returned_chunks'] for m in metrics.values()),'mean_selected_paragraphs':statistics.mean(m['selected_paragraphs'] for m in metrics.values()),'budget_exclusion_questions':sum(r['result']['excluded']['budget']>0 for r in data),'source_cap_questions':sum(r['result']['excluded']['source_limit']>0 for r in data)}
 assert conditions[label]['complete']==receipt['summaries'][label]['complete']
 per[label]=metrics;write(f'w{w}-per-question.json',metrics)
 bindings[file.name]=sha(file);bindings[f'w{w}-per-question.json']=sha(out/f'w{w}-per-question.json')
paired={}
for w in [0,0.1,0.25,0.3,0.4]:
 label=str(w);paired[label]={}
 for field in ['strict_complete','strict_coverage','evidence_f1']:
  chosen=[q for q in ids if per[label][q]['eligible']] if field!='evidence_f1' else ids
  groups=collections.defaultdict(list)
  for q in chosen:groups[per[label][q]['paper_id']].append(q)
  deltas={q:per[label][q][field]-per['0.5'][q][field] for q in chosen}
  clusters=np.array([[sum(deltas[q] for q in qs),len(qs)] for qs in groups.values()])
  rng=np.random.default_rng(20260920);boot=[]
  for _ in range(10000):
   sampled=clusters[rng.integers(0,len(clusters),len(clusters))].sum(axis=0);boot.append(sampled[0]/sampled[1])
  values=np.array(list(deltas.values()))
  paired[label][field]={'difference':float(values.mean()),'ci95':np.quantile(boot,[.025,.975]).tolist(),'paper_clusters':len(groups),'questions':len(chosen),'wins':int((values>1e-12).sum()),'losses':int((values < -1e-12).sum()),'ties':int((abs(values)<=1e-12).sum())}
summary={'created':datetime.datetime.now(datetime.timezone.utc).isoformat(),'plan':plan,'conditions':conditions,'versus_bm25_0_5':paired,'official_per_question_equal':True,'strict_line_coverage_independently_recomputed':True,'paper_cluster_bootstrap':{'iterations':10000,'seed':20260920,'unit':'paper; retain all sampled questions of each resampled paper','limitation':'Small exploratory already-opened subset; no multiplicity correction or general optimality claim'},'bindings':bindings,'implementation':{'scorer_sha256':sha(__file__),'official_qasper_scorer_sha256':sha(root/'reference/qasper_evaluator.py'),'python':sys.version,'numpy':importlib.metadata.version('numpy')}}
write('summary.json',summary)
print(json.dumps({'sample':{'questions':101,'eligible':plan['eligible'],'categories':plan['categories'],'papers':plan['papers']},'conditions':conditions,'paired':paired}))
