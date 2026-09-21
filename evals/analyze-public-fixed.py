"""Paired diagnostics of the frozen fixed-unit runs; no model calls or parameter changes."""
import sys,json,pathlib,math,statistics,hashlib
root=pathlib.Path(sys.argv[1]).resolve();scope=sys.argv[2]
sys.path.insert(0,str(root/'scoring-tools'))
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parent/'lib'))
from public_score_validation import unique_rows, validate_per_question
import numpy as np
import pyndeval
def rows(p):
 with open(p,encoding='utf8') as f:return [json.loads(l) for l in f if l.strip()]
def sha(p):
 with open(p,'rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
score_dir=pathlib.Path(sys.argv[3]).resolve() if len(sys.argv)>3 else root/'analysis'
assert score_dir.is_relative_to(root)
receipt_file=score_dir/f'{scope}-official-score.json'
receipt=json.loads(receipt_file.read_text(encoding='utf8'))
query_file=root/'data'/('du-queries.jsonl' if scope=='du' else f'freshstack-{scope}-queries.jsonl')
query_rows=rows(query_file);ids=sorted(q.get('query_id',q.get('id')) for q in query_rows)
assert len(ids)==len(set(ids))=={'langchain':203,'godot':99,'du':2000}[scope]
assert sha(query_file)==receipt['bindings'][str(query_file.relative_to(root)).replace(chr(92),'/')]
runs={};per={};source_bindings={str(receipt_file.relative_to(root)).replace(chr(92),'/'):sha(receipt_file)}
for k in [30,10]:
 run_file=root/f'fixed/{scope}-rrf{k}.jsonl';score_file=score_dir/f'{scope}-rrf{k}-per-question.json'
 for file,expected_hash in [(run_file,receipt['bindings'][str(run_file.relative_to(root)).replace(chr(92),'/')]),(score_file,receipt['per_question_bindings'][str(score_file.relative_to(root)).replace(chr(92),'/')])]:
  assert sha(file)==expected_hash, 'Score/run binding mismatch: '+str(file)
  source_bindings[str(file.relative_to(root)).replace(chr(92),'/')]=expected_hash
 runs[k]={r['id']:r for r in unique_rows(rows(run_file),ids)}
 per[k]=json.loads(score_file.read_text(encoding='utf8'))
 assert receipt['results']['rrf'+str(k)]['questions']==len(ids)
 validate_per_question(per[k],ids,receipt['results']['rrf'+str(k)]['metrics'],['ndcg_cut_10','recall_10','recall_50','recip_rank'])
if scope!='du':
 queries={q['query_id']:q for q in rows(root/f'data/freshstack-{scope}-queries.jsonl')}
 qrels=[]
 for qid in ids:
  for nugget in queries[qid]['nuggets']:
   relevance={d:0 for d in nugget['non_relevant_corpus_ids']}
   relevance.update({d:1 for d in nugget['relevant_corpus_ids']})
   qrels.extend(pyndeval.SubtopicQrel(qid,nugget['_id'],doc,rel) for doc,rel in relevance.items())
 evaluator=pyndeval.RelevanceEvaluator(qrels,measures=['alpha-nDCG@10'])
 for k in [30,10]:
  scored=evaluator.evaluate([pyndeval.ScoredDoc(qid,r['id'],r['rank_score']) for qid in ids for r in runs[k][qid]['rankings'][:10]])
  for q in ids:
   per[k].setdefault(q,{})['alpha-nDCG@10']=scored.get(q,{}).get('alpha-nDCG@10',0)
   docs={r['id'] for r in runs[k][q]['rankings'][:20]}
   nuggets=queries[q]['nuggets']
   per[k][q]['Coverage@20']=round(sum(bool(docs.intersection(n['relevant_corpus_ids'])) for n in nuggets)/len(nuggets),5)
  for metric in ['alpha-nDCG@10','Coverage@20']:
   assert math.isclose(round(statistics.mean(per[k][q][metric] for q in ids),4),receipt['results']['rrf'+str(k)]['metrics'][metric],abs_tol=1e-10)
 metrics=['alpha-nDCG@10','Coverage@20','recall_50']
else:metrics=['ndcg_cut_10','recall_10','recall_50']
paired={}
for metric in metrics:
 deltas=np.array([per[10].get(q,{}).get(metric,0)-per[30].get(q,{}).get(metric,0) for q in ids])
 rng=np.random.default_rng(20260919)
 boot=[float(deltas[rng.integers(0,len(deltas),len(deltas))].mean()) for _ in range(10000)]
 paired[metric]={'rrf10_minus_rrf30':float(deltas.mean()),'query_bootstrap_ci95':np.quantile(boot,[.025,.975]).tolist(),'wins':int((deltas>1e-12).sum()),'losses':int((deltas < -1e-12).sum()),'ties':int((abs(deltas)<=1e-12).sum()),'win_ids':[q for q,d in zip(ids,deltas) if d>1e-12],'loss_ids':[q for q,d in zip(ids,deltas) if d < -1e-12]}
diagnostics={}
for k in [30,10]:
 all_rows=list(runs[k].values())
 for row in all_rows:
  for r in row['rankings']:
   expected=(0.5/(k+r['bm25_rank']) if r['bm25_rank'] else 0)+(1/(k+r['dense_rank']) if r['dense_rank'] else 0)
   assert math.isclose(expected,r['rrf_score'],abs_tol=1e-12)
 diagnostics[str(k)]={'empty':sum(not r['rankings'] for r in all_rows),'mean_candidates':statistics.mean(len(r['rankings']) for r in all_rows),'mean_bm25_candidates':statistics.mean(r['candidates']['bm25'] for r in all_rows),'mean_dense_candidates':statistics.mean(r['candidates']['dense'] for r in all_rows),'offline_p50_ms':float(np.quantile([r['offline_ms'] for r in all_rows],.5)),'offline_p95_ms':float(np.quantile([r['offline_ms'] for r in all_rows],.95))}
pool_equal=all({r['id'] for r in runs[30][q]['rankings']}=={r['id'] for r in runs[10][q]['rankings']} for q in ids)
assert pool_equal
output={'scope':scope,'questions':len(ids),'paired':paired,'diagnostics':diagnostics,'same_candidate_pool_all_queries':pool_equal,'top10_order_changed':sum([r['id'] for r in runs[30][q]['rankings'][:10]]!=[r['id'] for r in runs[10][q]['rankings'][:10]] for q in ids),'top10_members_changed':sum({r['id'] for r in runs[30][q]['rankings'][:10]}!={r['id'] for r in runs[10][q]['rankings'][:10]} for q in ids),'bootstrap':{'unit':'query','iterations':10000,'seed':20260919,'limitation':'Query-level uncertainty conditional on this fixed corpus; not cross-domain generalization or multiple-comparison correction.'}}
output['bindings']=source_bindings
output['implementation']={'analyzer_sha256':sha(__file__),'validator_sha256':sha(pathlib.Path(__file__).resolve().parent/'lib/public_score_validation.py')}
(score_dir/f'{scope}-paired-analysis.json').write_text(json.dumps(output,indent=2)+'\n',encoding='utf8')
print(json.dumps({**output,'paired':{m:{k:v for k,v in d.items() if not k.endswith('_ids')} for m,d in paired.items()}}))
