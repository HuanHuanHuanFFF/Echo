"""Independently score the frozen MiniSearch experiment with official evaluators."""
import sys,json,pathlib,hashlib,statistics,importlib.util,importlib.metadata,math,datetime,collections,subprocess

root=pathlib.Path(sys.argv[1]).resolve();out=pathlib.Path(sys.argv[2]).resolve()
assert out.is_relative_to(root) and out!=root and not (out/'summary.json').exists()
sys.path.insert(0,str(root/'scoring-tools'))
sys.path.insert(0,str(pathlib.Path(__file__).parent/'lib'))
import pytrec_eval,pyndeval,numpy as np
from public_score_validation import fixed_run

def read(p):return json.loads(p.read_text(encoding='utf8'))
def rows(p):
 with open(p,encoding='utf8') as f:
  for l in f:
   if l.strip():yield json.loads(l)
def sha(p):
 with open(p,'rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def write(name,value):
 if (out/name).exists():
  assert read(out/name)==value, 'Refuse changed partial score output: '+name
  return
 with open(out/name,'x',encoding='utf8') as f:json.dump(value,f,ensure_ascii=False,indent=2);f.write('\n')
def module(name,p):
 spec=importlib.util.spec_from_file_location(name,p);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
plan=read(out/'freeze.json');receipt=read(out/'run-receipt.json')
arms=['default','k_minus30','b_minus30'];labels=['dense']+[a+'-'+m for a in ['sqlite']+arms for m in ['bm25','hybrid']]
assert plan['arms']=={'default':{'k':1.2,'b':.7,'d':.5},'k_minus30':{'k':.84,'b':.7,'d':.5},'b_minus30':{'k':1.2,'b':.49,'d':.5}}
assert receipt['unchanged_inputs'] and plan['fixed']['rrf_k']==10 and plan['fixed']['bm25_weight']==.5
for p,h in receipt['bindings'].items():assert sha(root/p)==h,p
bindings={'freeze.json':sha(out/'freeze.json'),'run-receipt.json':sha(out/'run-receipt.json')}

def node_tie_order(ids):
 # Echo's explicit tie contract is Node localeCompare, not Python code-point order.
 code = "let s='';for await(const b of process.stdin)s+=b;const ids=JSON.parse(s);ids.sort((a,b)=>a.localeCompare(b));process.stdout.write(JSON.stringify({node:process.version,icu:process.versions.icu,ids}));"
 result=subprocess.run(['node','--input-type=module','-e',code],input=json.dumps(list(ids)),capture_output=True,text=True,encoding='utf8',check=True)
 value=json.loads(result.stdout)
 assert value['node']==plan['environment']['node'] and value['icu']==plan['environment']['icu']
 assert len(value['ids'])==len(set(value['ids']))==len(ids) and set(value['ids'])==set(ids)
 return {d:i for i,d in enumerate(value['ids'])}

def expected_ranks(pool,label):
 if label=='dense':return [r['id'] for r in pool['dense']]
 arm,mode=label.rsplit('-',1);bm=pool[arm];den=pool['dense'];assert len(bm)<=60 and len(den)<=60
 assert len({x['id'] for x in bm})==len(bm)
 if mode=='bm25':return [r['id'] for r in bm]
 scores={}
 for i,r in enumerate(bm):scores[r['id']]=scores.get(r['id'],0)+.5/(10+i+1)
 for i,r in enumerate(den):scores[r['id']]=scores.get(r['id'],0)+1/(10+i+1)
 return sorted(scores,key=lambda d:(-scores[d],tie_order[d]))

def paired(per,ids,candidate,baseline,metrics,papers=False):
 result={}
 for metric in metrics:
  chosen=[q for q in ids if per[candidate][q].get('eligible',True)] if metric in ['strict_complete','strict_coverage'] else ids
  delta=np.array([per[candidate][q][metric]-per[baseline][q][metric] for q in chosen]);rng=np.random.default_rng(20260920)
  if papers:
   groups=collections.defaultdict(list)
   for q,d in zip(chosen,delta):groups[per[candidate][q]['paper_id']].append(d)
   a=np.array([[sum(g),len(g)] for g in groups.values()]);boot=[]
   for _ in range(10000):
    sample=a[rng.integers(0,len(a),len(a))].sum(axis=0);boot.append(sample[0]/sample[1])
  else:boot=[delta[rng.integers(0,len(ids),len(ids))].mean() for _ in range(10000)]
  result[metric]={'delta':float(delta.mean()),'ci95':np.quantile(boot,[.025,.975]).tolist(),'wins':int((delta>1e-12).sum()),'losses':int((delta< -1e-12).sum()),'ties':int((abs(delta)<=1e-12).sum()),'questions':len(chosen)}
 return result

fresh=module('freshstack_official',root/'reference/freshstack_metrics.py')
summary={'created':datetime.datetime.now(datetime.timezone.utc).isoformat(),'plan':plan,'results':{},'bindings':bindings,'bootstrap':{'iterations':10000,'seed':20260920,'units':'query for fixed units; paper for QASPER','limitation':'Exploratory existing samples; no multiplicity correction or holdout claim'},'implementation':{'script_sha256':sha(__file__),'validator_sha256':sha(pathlib.Path(__file__).parent/'lib/public_score_validation.py'),'python':sys.version,'numpy':importlib.metadata.version('numpy'),'pytrec_eval':importlib.metadata.version('pytrec-eval-terrier')}}
for scope in ['langchain','godot','du']:
 ids=plan['cohorts'][scope]['ids'];assert len(ids)==len(set(ids))=={'langchain':20,'godot':10,'du':200}[scope]
 assert ids==read(root/'analysis/weight-pilot-10pct-2026-09-20-v1/freeze.json')['cohorts'][scope]['ids']
 queries={q.get('query_id',q.get('id')):q for q in rows(root/'data'/('du-queries.jsonl' if scope=='du' else f'freshstack-{scope}-queries.jsonl'))}
 corpus_ids={d.get('_id',d.get('id')) for d in rows(root/'data'/('du-corpus.jsonl' if scope=='du' else f'freshstack-{scope}-corpus.jsonl'))}
 assert len(corpus_ids)==plan['document_counts'][scope]
 tie_order=node_tie_order(corpus_ids)
 pools=list(rows(out/f'{scope}-candidates.jsonl'));assert [p['id'] for p in pools]==ids
 qrels={};nuggets={};mapping={}
 if scope=='du':
  for r in rows(root/'data/du-qrels.jsonl'):
   if r['qid'] in ids:qrels.setdefault(r['qid'],{})[r['pid']]=r['score']
 else:
  for q in ids:
   mapping[q]=[]
   for n in queries[q]['nuggets']:
    nid=n['_id'];mapping[q].append(nid);assert nid not in nuggets
    values={d:0 for d in n['non_relevant_corpus_ids']};values.update({d:1 for d in n['relevant_corpus_ids']});nuggets[nid]=values
    for d,r in values.items():qrels.setdefault(q,{})[d]=qrels.setdefault(q,{}).get(d,0)+r
 per={};conditions={}
 for label in labels:
  file=out/f'{scope}-{label}.jsonl';data=list(rows(file));assert [r['id'] for r in data]==ids
  for r,p in zip(data,pools):
   assert r['condition']==label and [x['id'] for x in r['rankings']]==expected_ranks(p,label)
  run=fixed_run(data,ids,corpus_ids,10)
  ev=pytrec_eval.RelevanceEvaluator(qrels,{'ndcg_cut.10','recall.10,50'}).evaluate(run)
  cut={q:dict(list(run[q].items())[:10]) for q in ids};rr=pytrec_eval.RelevanceEvaluator(qrels,{'recip_rank'}).evaluate(cut)
  values={q:{**{m:ev.get(q,{}).get(m,0) for m in ['ndcg_cut_10','recall_10','recall_50']},'MRR@10':rr.get(q,{}).get('recip_rank',0),'Hit@10':int(any(qrels[q].get(d,0)>0 for d in cut[q]))} for q in ids}
  if scope!='du':
   nq=[pyndeval.SubtopicQrel(q,n,d,r) for q in ids for n in mapping[q] for d,r in nuggets[n].items()]
   alpha=pyndeval.RelevanceEvaluator(nq,measures=['alpha-nDCG@10']).evaluate([pyndeval.ScoredDoc(q,d,s) for q in ids for d,s in cut[q].items()])
   for q in ids:
    values[q]['alpha-nDCG@10']=alpha.get(q,{}).get('alpha-nDCG@10',0)
    selected=set(list(run[q])[:20]);values[q]['Coverage@20']=round(sum(any(nuggets[n].get(d,0)>0 for d in selected) for n in mapping[q])/len(mapping[q]),5)
  metrics={m:statistics.mean(values[q][m] for q in ids) for m in values[ids[0]]}
  assert all(math.isfinite(v) and 0<=v<=1 for v in metrics.values())
  if scope!='du':
   check={**fresh.alpha_ndcg(nuggets,mapping,run,[10]),**fresh.coverage(nuggets,mapping,run,[20]),**fresh.recall(qrels,run,[10,50])}
   for m in ['alpha-nDCG@10','Coverage@20']:assert math.isclose(round(metrics[m],4),check[m],abs_tol=1e-12)
   for k in [10,50]:assert math.isclose(round(metrics[f'recall_{k}'],4),check[f'Recall@{k}'],abs_tol=1e-12)
  if label in ['dense','sqlite-bm25','sqlite-hybrid']:
   old_label={'dense':'dense','sqlite-bm25':'bm25','sqlite-hybrid':'rrf10'}[label]
   old=read(root/f'analysis/mode-contrast-2026-09-20-v1/{scope}-{old_label}-per-question.json')
   for q in ids:
    for m,v in values[q].items():assert math.isclose(v,old[q][m],abs_tol=1e-10),(scope,label,q,m)
  per[label]=values;write(f'{scope}-{label}-per-question.json',values)
  conditions[label]={'questions':len(ids),'metrics':metrics,'hit10_count':sum(values[q]['Hit@10'] for q in ids)}
 comparisons={}
 metric=['ndcg_cut_10','recall_10','recall_50'] if scope=='du' else ['alpha-nDCG@10','Coverage@20','recall_50']
 for mode in ['bm25','hybrid']:
  for a in ['k_minus30','b_minus30']:comparisons[a+'-'+mode]=paired(per,ids,a+'-'+mode,'default-'+mode,metric)
  comparisons['default-'+mode+'-vs-sqlite']=paired(per,ids,'default-'+mode,'sqlite-'+mode,metric)
 summary['results'][scope]={'conditions':conditions,'paired':comparisons,'full_corpus_documents':len(corpus_ids),'old_sqlite_and_dense_per_question_equal':True}
 print(json.dumps({'scope':scope,'conditions':conditions}),flush=True)

scope='qasper';ids=plan['cohorts'][scope]['ids'];assert len(ids)==101
assert ids==read(root/'analysis/qasper-weight-pilot-2026-09-20-v1/freeze.json')['ids']
queries={q['id']:q for q in rows(root/'prepared/qasper-queries.jsonl')};docs={d['id']:d for d in rows(root/'prepared/qasper-docs.jsonl')}
texts={p:pathlib.Path(docs[p]['file']).read_bytes().decode('utf8').split('\n') for p in {queries[q]['paper_id'] for q in ids}}
official=module('qasper_official',root/'reference/qasper_evaluator.py');papers={p['id']:p for p in rows(root/'data/qasper-dev.jsonl')};gold_all=official.get_answers_and_evidence(papers,False);gold={q:gold_all[q] for q in ids}
per={};conditions={};pools={p['id']:p for p in rows(out/'qasper-candidates.jsonl')}
tie_order=node_tie_order({x['id'] for p in pools.values() for key in ['dense','sqlite']+arms for x in p[key]})
for label in labels:
 data=list(rows(out/f'qasper-{label}.jsonl'));assert [r['id'] for r in data]==ids
 metrics={};predictions={}
 for r in data:
  q=queries[r['id']];doc=docs[q['paper_id']];lines=texts[q['paper_id']];covered=set();mode='dense' if label=='dense' else label.rsplit('-',1)[1]
  assert r['condition']==label and r['request']['filters']['source_ids']==[q['source_id']]
  assert r['request']['overrides']['mode']==mode and r['result']['applied']['rrf_k']==10 and r['result']['applied']['max_chunks_per_source']==3
  assert r['result']['applied']['bm25_weight']==.5 and r['result']['applied']['dense_weight']==1
  assert r['request_chars']+r['response_chars']<=16000 and len(r['result']['results'])<=3
  ranked=expected_ranks(pools[q['id']],label)
  # All candidates belong to the target paper; verify first-cap selection in this no-budget-exclusion sample.
  if r['result']['excluded']['budget']==0:assert [p['chunk_id'] for p in r['result']['results']]==ranked[:3]
  for piece in r['result']['results']:
   assert piece['source_id']==q['source_id']==doc['source_id']
   start,end=piece['start_line'],piece['end_line'];assert 1<=start<=end<=len(lines)
   assert '\n'.join(lines[start-1:end])==piece['text'];covered.update(i for i in range(start,end+1) if lines[i-1].strip())
  full=[p for p in doc['paragraphs'] if all(i in covered for i in range(p['start_line'],p['end_line']+1) if lines[i-1].strip())]
  selected={p['id'] for p in full};assert [p['id'] for p in full]==r['score']['selected_paragraphs']
  valid=[a for a in q['annotations'] if a['valid']]
  coverage=max((sum(bool(selected.intersection(e['paragraph_ids'])) for e in a['evidence'])/len(a['evidence']) for a in valid),default=None)
  complete=any(all(bool(selected.intersection(e['paragraph_ids'])) for e in a['evidence']) for a in valid)
  assert complete==r['score']['strict_complete'] and coverage==r['score']['strict_coverage']
  evidence=[p['text'] for p in full];predictions[q['id']]={'answer':'','evidence':evidence}
  f1=max(official.paragraph_f1_score(evidence,a['evidence']) for a in gold[q['id']]);assert math.isclose(f1,r['score']['official_formula_evidence_f1'],abs_tol=1e-12)
  metrics[q['id']]={'paper_id':q['paper_id'],'eligible':q['eligible'],'strict_complete':int(complete),'strict_coverage':coverage,'evidence_f1':f1,'context_chars':r['request_chars']+r['response_chars'],'returned_chunks':len(r['result']['results'])}
 ev=official.evaluate(gold,predictions);assert ev['Missing predictions']==0
 assert math.isclose(ev['Evidence F1'],statistics.mean(m['evidence_f1'] for m in metrics.values()),abs_tol=1e-12)
 eligible=[m for m in metrics.values() if m['eligible']];assert len(eligible)==78
 conditions[label]={'questions':101,'eligible':78,'complete':sum(m['strict_complete'] for m in eligible),'complete_rate':statistics.mean(m['strict_complete'] for m in eligible),'strict_coverage':statistics.mean(m['strict_coverage'] for m in eligible),'official_evidence_f1_all':ev['Evidence F1'],'mean_context_chars':statistics.mean(m['context_chars'] for m in metrics.values()),'budget_exclusion_questions':sum(r['result']['excluded']['budget']>0 for r in data)}
 per[label]=metrics;write(f'qasper-{label}-per-question.json',metrics)
comparisons={}
for mode in ['bm25','hybrid']:
 for a in ['k_minus30','b_minus30']:comparisons[a+'-'+mode]=paired(per,ids,a+'-'+mode,'default-'+mode,['strict_complete','strict_coverage','evidence_f1'],True)
 comparisons['default-'+mode+'-vs-sqlite']=paired(per,ids,'default-'+mode,'sqlite-'+mode,['strict_complete','strict_coverage','evidence_f1'],True)
summary['results']['qasper']={'conditions':conditions,'paired':comparisons,'official_f1_and_strict_lines_independently_recomputed':True}
for f in sorted(out.iterdir()):
 if f.is_file() and f.suffix in ['.json','.jsonl']:bindings[f.name]=sha(f)
summary['resources']={}
for scope,r in receipt['receipts'].items():
 mem={x['stage']:x for x in r['memory']}
 summary['resources'][scope]={'documents':r['documents'],'build_ms':r['index_build_ms'],'process_rss_before_mib':mem['before_index']['rss']/1048576,'process_rss_after_index_gc_mib':mem['after_index_gc']['rss']/1048576,'heap_used_after_index_gc_mib':mem['after_index_gc']['heapUsed']/1048576,'process_peak_rss_mib':r['max_rss_kib']/1024,'query_ms':{a:{'median':statistics.median(v),'p95':float(np.quantile(v,.95))} for a,v in r['query_ms'].items()},'limitation':'Whole child process including Node/runtime/SQLite. Single serial run; not engine-only memory or production latency.'}
write('summary.json',summary)
print(json.dumps({'scope':'qasper','conditions':conditions,'resources':summary['resources']}),flush=True)
