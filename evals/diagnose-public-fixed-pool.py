"""Coverage diagnostics on existing candidate pools, not additional retrieval arms."""
import json,sys,pathlib,statistics
root=pathlib.Path(sys.argv[1]).resolve();scope=sys.argv[2]
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parent/'lib'))
from public_score_validation import unique_rows
def rows(p):
 with open(p,encoding='utf8') as f:return [json.loads(l) for l in f if l.strip()]
if scope=='du':
 qs={q['id']:q for q in rows(root/'data/du-queries.jsonl')};gold={q:set() for q in qs}
 for q in rows(root/'data/du-qrels.jsonl'):
  if q['score']>0:gold[q['qid']].add(q['pid'])
 groups={q:[g] for q,g in gold.items()}
else:
 qs={q['query_id']:q for q in rows(root/f'data/freshstack-{scope}-queries.jsonl')}
 groups={q:[set(n['relevant_corpus_ids']) for n in v['nuggets']] for q,v in qs.items()}
result={};per=[]
for k in [30,10]:
 run=unique_rows(rows(root/f'fixed/{scope}-rrf{k}.jsonl'),qs)
 bucket={name:[] for name in ['top10','top20','top50','pool','dense_pool','bm25_pool']}
 all_supported={name:0 for name in bucket};rows_by_q={}
 for row in run:
  q=row['id'];ranking=row['rankings']
  sets={name:{x['id'] for x in (ranking[:int(name[3:])] if name.startswith('top') else ranking) if name not in ['dense_pool','bm25_pool'] or x['dense_rank' if name=='dense_pool' else 'bm25_rank'] is not None} for name in bucket}
  scores={}
  for name,docs in sets.items():
   if scope=='du':score=len(docs&gold[q])/len(gold[q])
   else:score=sum(bool(docs&g) for g in groups[q])/len(groups[q])
   bucket[name].append(score);all_supported[name]+=int(score==1)
   scores[name]=score
  rows_by_q[q]=scores
  if k==30:per.append({'id':q,**scores})
 result['rrf'+str(k)]={'coverage_macro':{name:statistics.mean(values) for name,values in bucket.items()},'no_relevant_support_queries':{name:sum(v==0 for v in values) for name,values in bucket.items()},'all_nuggets_supported_queries':all_supported if scope!='du' else None}
summary={'scope':scope,'questions':len(qs),'results':result,'meaning':'FreshStack nugget coverage; Du relevant-document recall (all qrels are not a required evidence set). Lane values describe support in the recorded top60 lane pools, not a new pure-mode top10 evaluation. All-pool support is diagnostic, not achievable packing accuracy or an official leaderboard metric.','per_query_rrf30':per}
(root/f'analysis/{scope}-candidate-pool.json').write_text(json.dumps(summary,indent=2)+'\n',encoding='utf8')
print(json.dumps({k:v for k,v in summary.items() if k!='per_query_rrf30'}))
