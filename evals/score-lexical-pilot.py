"""Official Du metrics for frozen word-tokenizer and IDF single-variable arms."""
import sys,json,pathlib,hashlib,importlib.metadata,statistics,math,datetime
root=pathlib.Path(sys.argv[1]).resolve();out=pathlib.Path(sys.argv[2]).resolve()
assert out.is_relative_to(root) and out!=root and not (out/'summary.json').exists()
sys.path.insert(0,str(root/'scoring-tools'));sys.path.insert(0,str(pathlib.Path(__file__).parent/'lib'))
import pytrec_eval,numpy as np
from public_score_validation import fixed_run
def read(p):return json.loads(p.read_text(encoding='utf8'))
def rows(p):
 with open(p,encoding='utf8') as f:return [json.loads(l) for l in f if l.strip()]
def sha(p):
 with open(p,'rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def write(name,obj):
 with open(out/name,'x',encoding='utf8') as f:json.dump(obj,f,ensure_ascii=False,indent=2);f.write('\n')
plan=read(out/'freeze.json');receipt=read(out/'run-receipt.json')
assert plan['arms']==['icu_sqlite','jieba_search','lucene_idf'] and plan['rrf_k']==10
assert plan['bm25_weight']==0.5 and plan['candidates_per_lane']==60
assert receipt['documents']==100001 and receipt['queries']==200
assert receipt['baseline_document_terms_equal'] and receipt['manual_sqlite_control_equal']
for p,h in receipt['bindings'].items():assert sha(root/p)==h,p
assert sha(out/'lexical.sqlite')==receipt['new_lexical_index_sha256']
ids=plan['ids'];assert len(ids)==len(set(ids))==200
assert ids==read(root/'analysis/weight-pilot-10pct-2026-09-20-v1/freeze.json')['cohorts']['du']['ids']
corpus_ids={r.get('_id',r.get('id')) for r in rows(root/'data/du-corpus.jsonl')};assert len(corpus_ids)==100001
qrels={}
for r in rows(root/'data/du-qrels.jsonl'):
 if r['qid'] in ids:qrels.setdefault(r['qid'],{})[r['pid']]=r['score']
assert set(qrels)==set(ids)
bindings={'freeze.json':sha(out/'freeze.json'),'run-receipt.json':sha(out/'run-receipt.json'),'candidates.jsonl':sha(out/'candidates.jsonl')}
pools=rows(out/'candidates.jsonl');assert [p['id'] for p in pools]==ids
labels=['dense']+[arm+'-'+mode for arm in plan['arms'] for mode in plan['modes']]
per={};conditions={}
for label in labels:
 file=out/(label+'.jsonl');data=rows(file)
 assert [r['id'] for r in data]==ids and all(r['condition']==label for r in data)
 for r,pool in zip(data,pools):
  if label=='dense':expected=[r['id'] for r in pool['dense']]
  else:
   arm,mode=label.rsplit('-',1);bm=pool[arm]
   assert len(bm)<=60 and len({r['id'] for r in bm})==len(bm)
   assert all(math.isfinite(r['score']) and r['score']>=0 for r in bm)
   if mode=='bm25':expected=[r['id'] for r in bm]
   else:
    scores={}
    for k,p in enumerate(bm):scores[p['id']]=scores.get(p['id'],0)+0.5/(10+k+1)
    for k,p in enumerate(pool['dense']):scores[p['id']]=scores.get(p['id'],0)+1/(10+k+1)
    expected=sorted(scores,key=lambda d:(-scores[d],d))
   if arm=='icu_sqlite':assert [p['id'] for p in pool['manual_sqlite']]==[p['id'] for p in bm]
  assert [x['id'] for x in r['rankings']]==expected
 run=fixed_run(data,ids,corpus_ids,10)
 evaluated=pytrec_eval.RelevanceEvaluator(qrels,{'ndcg_cut.10','recall.10,50'}).evaluate(run)
 cut={q:dict(list(run[q].items())[:10]) for q in ids}
 rr=pytrec_eval.RelevanceEvaluator(qrels,{'recip_rank'}).evaluate(cut)
 values={q:{**{m:evaluated.get(q,{}).get(m,0) for m in ['ndcg_cut_10','recall_10','recall_50']},'MRR@10':rr.get(q,{}).get('recip_rank',0),'Hit@10':int(any(qrels[q].get(d,0)>0 for d in cut[q]))} for q in ids}
 assert all(math.isfinite(v) and 0<=v<=1 for q in ids for v in values[q].values())
 if label in ['dense','icu_sqlite-bm25','icu_sqlite-hybrid']:
  old_label={'dense':'dense','icu_sqlite-bm25':'bm25','icu_sqlite-hybrid':'rrf10'}[label]
  old=read(root/f'analysis/mode-contrast-2026-09-20-v1/du-{old_label}-per-question.json')
  for q in ids:
   for metric,value in values[q].items():assert math.isclose(value,old[q][metric],abs_tol=1e-10),(label,q,metric)
 per[label]=values
 write(label+'-per-question.json',values)
 bindings[file.name]=sha(file);bindings[label+'-per-question.json']=sha(out/(label+'-per-question.json'))
 conditions[label]={'questions':200,'metrics':{m:statistics.mean(values[q][m] for q in ids) for m in values[ids[0]]},'hit10_count':sum(values[q]['Hit@10'] for q in ids),'empty_queries':sum(not run[q] for q in ids)}
def compare(candidate,baseline,metrics):
 result={}
 for metric in metrics:
  delta=np.array([per[candidate][q][metric]-per[baseline][q][metric] for q in ids]);rng=np.random.default_rng(20260920)
  boot=np.array([delta[rng.integers(0,len(ids),len(ids))].mean() for _ in range(10000)])
  result[metric]={'difference':float(delta.mean()),'ci95':np.quantile(boot,[.025,.975]).tolist(),'wins':int((delta>1e-12).sum()),'losses':int((delta < -1e-12).sum()),'ties':int((abs(delta)<=1e-12).sum())}
 return result
paired={}
for arm in ['jieba_search','lucene_idf']:
 for mode in plan['modes']:
  key=arm+'-'+mode
  paired[key]=compare(key,'icu_sqlite-'+mode,['ndcg_cut_10','recall_10','recall_50'])
against_dense={arm:compare(arm+'-hybrid','dense',['ndcg_cut_10']) for arm in plan['arms']}
summary={'created':datetime.datetime.now(datetime.timezone.utc).isoformat(),'plan':plan,'conditions':conditions,'paired_vs_same_mode_icu':paired,'hybrid_vs_dense':against_dense,'old_baseline_per_question_scores_equal':True,'ranking_formulas_checked':True,'bootstrap':{'iterations':10000,'seed':20260920,'unit':'query','limitation':'Exploratory existing 200-query subset; no multiplicity or held-out claim'},'bindings':bindings,'implementation':{'scorer_sha256':sha(__file__),'validator_sha256':sha(pathlib.Path(__file__).parent/'lib/public_score_validation.py'),'python':sys.version,'numpy':importlib.metadata.version('numpy'),'pytrec_eval':importlib.metadata.version('pytrec-eval-terrier')}}
write('summary.json',summary)
print(json.dumps({'conditions':conditions,'paired':paired,'hybrid_vs_dense':against_dense}))
