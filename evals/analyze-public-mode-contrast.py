"""Post-hoc single-lane rescoring of frozen real hybrid ranks; no retrieval or API."""
import sys,json,pathlib,hashlib,statistics,importlib.util,importlib.metadata,datetime,math
root=pathlib.Path(sys.argv[1]).resolve()
out=pathlib.Path(sys.argv[2]).resolve()
assert out.is_relative_to(root) and out != root
assert not out.exists(), "Refuse overwrite: choose a new output directory"
out.mkdir(parents=True)
sys.path.insert(0,str(root/'scoring-tools'))
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parent/'lib'))
import numpy as np
import pytrec_eval,pyndeval
from public_score_validation import fixed_run,unique_rows
from public_lane_projection import lane_ids
def sha(p):
 with open(p,'rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def rows(p):
 with open(p,encoding='utf8') as f:return [json.loads(x) for x in f if x.strip()]
def write(name,obj):
 with open(out/name,'x',encoding='utf8') as f:json.dump(obj,f,ensure_ascii=False,indent=2);f.write('\n')
def relative(p):return str(p.relative_to(root)).replace(chr(92),'/')
spec=importlib.util.spec_from_file_location('official_freshstack',root/'reference/freshstack_metrics.py')
official=importlib.util.module_from_spec(spec);spec.loader.exec_module(official)
plan={'created':datetime.datetime.now(datetime.timezone.utc).isoformat(),'kind':'Post-hoc diagnostic rescoring; original frozen benchmark remains unchanged','scopes':{'langchain':203,'godot':99,'du':2000},'conditions':['dense','bm25','rrf30','rrf10'],'model':'qwen3.7-text-embedding','dimensions':1024,'hybrid_weights':{'bm25':0.5,'dense':1},'candidates_per_lane':60,'min_dense_similarity':0.3,'title_weight':2,'lexical':'ICU zh-CN','parent_source_cap':None,'context_budget':None,'chunking':'Official fixed units, unchanged','new_api_calls':0,'new_retrieval_runs_for_scores':0,'paired':{'conditions_minus_dense':['rrf30','rrf10'],'iterations':10000,'seed':20260920,'unit':'query within each fixed corpus','freshstack_metrics':['alpha-nDCG@10','Coverage@20','recall_50'],'du_metrics':['ndcg_cut_10','recall_10','recall_50'],'limitation':'Exploratory, already-opened data; no untouched holdout or multiple-comparison correction'},'implementation':{str(p):sha(p) for p in [pathlib.Path(__file__),pathlib.Path(__file__).parent/'lib/public_lane_projection.py',pathlib.Path(__file__).parent/'lib/public_score_validation.py']},'versions':{x:importlib.metadata.version(x) for x in ['pytrec-eval-terrier','pyndeval','numpy']}}
write('freeze.json',plan)
summary={'plan':plan,'results':{},'bindings':{},'scoring_implementation':{'freshstack_metrics_sha256':sha(root/'reference/freshstack_metrics.py'),'pytrec_wrapper_sha256':sha(pytrec_eval.__file__)}}
for scope,count in plan['scopes'].items():
 score_file=root/f'analysis/{scope}-official-score.json';receipt=json.loads(score_file.read_text(encoding='utf8'))
 summary['bindings'][relative(score_file)]=sha(score_file)
 for p,h in receipt['bindings'].items():
  assert sha(root/p)==h, 'Original binding mismatch: '+p
  summary['bindings'][p]=h
 query_file=root/'data'/('du-queries.jsonl' if scope=='du' else f'freshstack-{scope}-queries.jsonl')
 queries=rows(query_file);ids=sorted(q.get('query_id',q.get('id')) for q in queries)
 assert len(ids)==len(set(ids))==count
 corpus_file=root/'data'/('du-corpus.jsonl' if scope=='du' else f'freshstack-{scope}-corpus.jsonl')
 corpus_ids={r.get('_id',r.get('id')) for r in rows(corpus_file)}
 raw={k:{r['id']:r for r in unique_rows(rows(root/f'fixed/{scope}-rrf{k}.jsonl'),ids)} for k in [30,10]}
 runs={f'rrf{k}':fixed_run(list(raw[k].values()),ids,corpus_ids,k) for k in [30,10]}
 lane_hashes={}
 for lane in ['dense','bm25']:
  runs[lane]={};h=hashlib.sha256()
  for q in ids:
   order=lane_ids(raw[30][q],lane)
   assert order==lane_ids(raw[10][q],lane), 'Lane order changed between frozen RRF arms'
   runs[lane][q]={d:len(order)-i for i,d in enumerate(order)}
   h.update((json.dumps([q,order],ensure_ascii=False,separators=(',',':'))+'\n').encode('utf8'))
  lane_hashes[lane]=h.hexdigest()
 qrels={};nuggets={};mapping={}
 if scope=='du':
  for r in rows(root/'data/du-qrels.jsonl'):qrels.setdefault(r['qid'],{})[r['pid']]=r['score']
 else:
  for q in queries:
   qid=q['query_id'];mapping[qid]=[]
   for n in q['nuggets']:
    nid=n['_id'];mapping[qid].append(nid)
    values={d:0 for d in n['non_relevant_corpus_ids']};values.update({d:1 for d in n['relevant_corpus_ids']})
    assert nid not in nuggets, 'Duplicate nugget ID'
    nuggets[nid]=values
    for d,rel in values.items():qrels.setdefault(qid,{})[d]=qrels.setdefault(qid,{}).get(d,0)+rel
 assert set(qrels)==set(ids)
 per={};aggregates={}
 for mode in plan['conditions']:
  run=runs[mode]
  raw_metrics=pytrec_eval.RelevanceEvaluator(qrels,{'ndcg_cut.10','recall.10,50'}).evaluate(run)
  cut10={q:dict(list(run[q].items())[:10]) for q in ids}
  rr=pytrec_eval.RelevanceEvaluator(qrels,{'recip_rank'}).evaluate(cut10)
  per[mode]={q:{m:raw_metrics.get(q,{}).get(m,0) for m in ['ndcg_cut_10','recall_10','recall_50']} for q in ids}
  for q in ids:
   per[mode][q]['MRR@10']=rr.get(q,{}).get('recip_rank',0)
   per[mode][q]['Hit@10']=int(any(qrels[q].get(d,0)>0 for d in cut10[q]))
  if scope!='du':
   nq=[pyndeval.SubtopicQrel(q,n,d,r) for q in ids for n in mapping[q] for d,r in nuggets[n].items()]
   alpha=pyndeval.RelevanceEvaluator(nq,measures=['alpha-nDCG@10']).evaluate([pyndeval.ScoredDoc(q,d,s) for q in ids for d,s in cut10[q].items()])
   for q in ids:
    per[mode][q]['alpha-nDCG@10']=alpha.get(q,{}).get('alpha-nDCG@10',0)
    for k in [10,20]:
     selected=set(list(run[q])[:k])
     per[mode][q][f'Coverage@{k}']=round(sum(any(nuggets[n].get(d,0)>0 for d in selected) for n in mapping[q])/len(mapping[q]),5)
  metrics={m:statistics.mean(per[mode][q][m] for q in ids) for m in per[mode][ids[0]]}
  assert all(math.isfinite(v) and 0<=v<=1 for q in ids for v in per[mode][q].values())
  if scope!='du':
   checked={**official.alpha_ndcg(nuggets,mapping,run,[10]),**official.coverage(nuggets,mapping,run,[10,20]),**official.recall(qrels,run,[10,50])}
   for m in ['alpha-nDCG@10','Coverage@10','Coverage@20']:assert math.isclose(round(metrics[m],4),checked[m],abs_tol=1e-12),(scope,mode,m)
   for k in [10,50]:assert math.isclose(round(metrics[f'recall_{k}'],4),checked[f'Recall@{k}'],abs_tol=1e-12)
  if mode.startswith('rrf'):
   old=receipt['results'][mode]['metrics']
   for m,v in metrics.items():
    if m in old:assert math.isclose(round(v,4) if m.startswith(('alpha','Coverage')) else v,old[m],abs_tol=1e-10),(scope,mode,m,v,old[m])
  aggregates[mode]={'questions':count,'metrics':metrics,'empty_queries':sum(not run[q] for q in ids),'mean_ranked_candidates':statistics.mean(len(run[q]) for q in ids)}
  write(f'{scope}-{mode}-per-question.json',per[mode])
 comparisons={}
 for mode in ['rrf30','rrf10']:
  comparisons[mode]={}
  for metric in plan['paired']['du_metrics' if scope=='du' else 'freshstack_metrics']:
   delta=np.array([per[mode][q][metric]-per['dense'][q][metric] for q in ids])
   rng=np.random.default_rng(plan['paired']['seed'])
   boot=np.array([delta[rng.integers(0,count,count)].mean() for _ in range(10000)])
   comparisons[mode][metric]={'hybrid_minus_dense':float(delta.mean()),'ci95':np.quantile(boot,[.025,.975]).tolist(),'wins':int((delta>1e-12).sum()),'losses':int((delta < -1e-12).sum()),'ties':int((abs(delta)<=1e-12).sum())}
 summary['results'][scope]={'conditions':aggregates,'hybrid_minus_dense':comparisons,'single_lane_order_same_in_both_frozen_runs':True,'projected_lane_order_sha256':lane_hashes,'original_hybrid_scores_reproduced':True}
 print(json.dumps({'scope':scope,**summary['results'][scope]}),flush=True)
summary['output_bindings']={relative(p):sha(p) for p in sorted(out.iterdir()) if p.is_file()}
write('summary.json',summary)
