"""Score only the frozen ten-percent weight pilot; original corpus stays complete."""
import sys,json,pathlib,hashlib,statistics,importlib.util,math,datetime
root=pathlib.Path(sys.argv[1]).resolve();out=pathlib.Path(sys.argv[2]).resolve()
assert out.is_relative_to(root) and out!=root
sys.path.insert(0,str(root/'scoring-tools'))
sys.path.insert(0,str(pathlib.Path(__file__).parent/'lib'))
import pytrec_eval,pyndeval,numpy as np
from public_score_validation import fixed_run
def rows(p):
 with open(p,encoding='utf8') as f:
  for line in f:
   if line.strip():yield json.loads(line)
def sha(p):
 with open(p,'rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def read(p):return json.loads(p.read_text(encoding='utf8'))
def write(name,x):
 with open(out/name,'x',encoding='utf8') as f:json.dump(x,f,ensure_ascii=False,indent=2);f.write('\n')
plan=read(out/'freeze.json');receipt=read(out/'run-receipt.json')
assert plan['bm25_weights']==[0,0.1,0.25,0.5] and plan['rrf_k']==30
assert not (out/'summary.json').exists()
for p,h in receipt['bindings'].items():assert sha(root/p)==h,p
spec=importlib.util.spec_from_file_location('official_freshstack',root/'reference/freshstack_metrics.py')
official=importlib.util.module_from_spec(spec);spec.loader.exec_module(official)
summary={'created':datetime.datetime.now(datetime.timezone.utc).isoformat(),'plan':plan,'results':{},'paired_method':{'iterations':10000,'seed':20260920,'unit':'query, within each sampled corpus','comparison':'each weight minus 0.5','limitation':'Small post-hoc pilot on already-opened questions; no holdout or multiplicity claim'},'implementation':{'scorer_sha256':sha(__file__),'validator_sha256':sha(pathlib.Path(__file__).parent/'lib/public_score_validation.py'),'freshstack_metrics_sha256':sha(root/'reference/freshstack_metrics.py'),'pytrec_wrapper_sha256':sha(pytrec_eval.__file__)},'bindings':{'freeze.json':sha(out/'freeze.json'),'run-receipt.json':sha(out/'run-receipt.json')}}
for scope,cohort in plan['cohorts'].items():
 ids=cohort['ids'];assert len(ids)==len(set(ids))==cohort['sample']=={'langchain':20,'godot':10,'du':200}[scope]
 query_file=root/'data'/('du-queries.jsonl' if scope=='du' else f'freshstack-{scope}-queries.jsonl')
 all_queries=list(rows(query_file));assert len(all_queries)==cohort['population']
 queries={q.get('query_id',q.get('id')):q for q in all_queries};assert set(ids)<=set(queries)
 corpus_file=root/'data'/('du-corpus.jsonl' if scope=='du' else f'freshstack-{scope}-corpus.jsonl')
 corpus_ids={r.get('_id',r.get('id')) for r in rows(corpus_file)}
 qrels={};nuggets={};mapping={}
 if scope=='du':
  for r in rows(root/'data/du-qrels.jsonl'):
   if r['qid'] in ids:qrels.setdefault(r['qid'],{})[r['pid']]=r['score']
 else:
  for qid in ids:
   mapping[qid]=[]
   for n in queries[qid]['nuggets']:
    nid=n['_id'];mapping[qid].append(nid);assert nid not in nuggets
    values={d:0 for d in n['non_relevant_corpus_ids']};values.update({d:1 for d in n['relevant_corpus_ids']});nuggets[nid]=values
    for d,rel in values.items():qrels.setdefault(qid,{})[d]=qrels.setdefault(qid,{}).get(d,0)+rel
 assert set(qrels)==set(ids)
 per={};conditions={}
 for w in plan['bm25_weights']:
  label=str(w);file=out/f'{scope}-w{w}.jsonl';data=list(rows(file));assert all(r['bm25_weight']==w for r in data)
  run=fixed_run(data,ids,corpus_ids,30)
  evaluated=pytrec_eval.RelevanceEvaluator(qrels,{'ndcg_cut.10','recall.10,50'}).evaluate(run)
  cut10={q:dict(list(run[q].items())[:10]) for q in ids}
  rr=pytrec_eval.RelevanceEvaluator(qrels,{'recip_rank'}).evaluate(cut10)
  per[label]={q:{m:evaluated.get(q,{}).get(m,0) for m in ['ndcg_cut_10','recall_10','recall_50']} for q in ids}
  for q in ids:
   per[label][q]['MRR@10']=rr.get(q,{}).get('recip_rank',0)
   per[label][q]['Hit@10']=int(any(qrels[q].get(d,0)>0 for d in cut10[q]))
  if scope!='du':
   nq=[pyndeval.SubtopicQrel(q,n,d,r) for q in ids for n in mapping[q] for d,r in nuggets[n].items()]
   alpha=pyndeval.RelevanceEvaluator(nq,measures=['alpha-nDCG@10']).evaluate([pyndeval.ScoredDoc(q,d,s) for q in ids for d,s in cut10[q].items()])
   for q in ids:
    per[label][q]['alpha-nDCG@10']=alpha.get(q,{}).get('alpha-nDCG@10',0)
    selected=set(list(run[q])[:20])
    per[label][q]['Coverage@20']=round(sum(any(nuggets[n].get(d,0)>0 for d in selected) for n in mapping[q])/len(mapping[q]),5)
  metrics={m:statistics.mean(per[label][q][m] for q in ids) for m in per[label][ids[0]]}
  assert all(math.isfinite(v) and 0<=v<=1 for q in ids for v in per[label][q].values())
  if scope!='du':
   checks={**official.alpha_ndcg(nuggets,mapping,run,[10]),**official.coverage(nuggets,mapping,run,[20]),**official.recall(qrels,run,[10,50])}
   for m in ['alpha-nDCG@10','Coverage@20']:assert math.isclose(round(metrics[m],4),checks[m],abs_tol=1e-12)
   for k in [10,50]:assert math.isclose(round(metrics[f'recall_{k}'],4),checks[f'Recall@{k}'],abs_tol=1e-12)
  if w in [0,0.5]:
   old_file=root/f"analysis/mode-contrast-2026-09-20-v1/{scope}-{'dense' if w==0 else 'rrf30'}-per-question.json"
   old=read(old_file);summary['bindings'][str(old_file.relative_to(root)).replace(chr(92),'/')]=sha(old_file)
   for q in ids:
    for m,v in per[label][q].items():assert math.isclose(v,old[q][m],abs_tol=1e-10),(scope,w,q,m)
  write(f'{scope}-w{w}-per-question.json',per[label])
  summary['bindings'][file.name]=sha(file)
  summary['bindings'][f'{scope}-w{w}-per-question.json']=sha(out/f'{scope}-w{w}-per-question.json')
  conditions[label]={'questions':len(ids),'metrics':metrics,'hit10_count':sum(per[label][q]['Hit@10'] for q in ids),'empty_queries':sum(not run[q] for q in ids)}
 comparisons={}
 for w in [0,0.1,0.25]:
  label=str(w);comparisons[label]={}
  for metric in (['ndcg_cut_10','recall_10','recall_50'] if scope=='du' else ['alpha-nDCG@10','Coverage@20','recall_50']):
   delta=np.array([per[label][q][metric]-per['0.5'][q][metric] for q in ids]);rng=np.random.default_rng(20260920)
   boot=np.array([delta[rng.integers(0,len(ids),len(ids))].mean() for _ in range(10000)])
   comparisons[label][metric]={'delta':float(delta.mean()),'ci95':np.quantile(boot,[.025,.975]).tolist(),'wins':int((delta>1e-12).sum()),'losses':int((delta < -1e-12).sum()),'ties':int((abs(delta)<=1e-12).sum())}
 summary['results'][scope]={'sample':len(ids),'full_corpus_documents':len(corpus_ids),'conditions':conditions,'versus_bm25_0_5':comparisons,'zero_and_half_match_original_sampled_scores':True}
 print(json.dumps({'scope':scope,**summary['results'][scope]}),flush=True)
write('summary.json',summary)
