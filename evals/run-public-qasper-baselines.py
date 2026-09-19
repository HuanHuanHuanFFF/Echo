import sys,json,pathlib,runpy,contextlib,io,importlib.util,importlib.metadata,hashlib
root=pathlib.Path(sys.argv[1]).resolve();sys.path.insert(0,str(root/'scoring-tools'))
def rows(p):
 with open(p,encoding='utf8') as f:
  return [json.loads(x) for x in f if x.strip()]
def module(name,p):
 s=importlib.util.spec_from_file_location(name,p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
data={p['id']:p for p in rows(root/'data/qasper-dev.jsonl')}
raw=root/'reference/qasper-dev-for-official.json';raw.write_text(json.dumps(data,ensure_ascii=False),encoding='utf8')
sys.argv=[str(root/'reference/qasper_heuristics.py'),str(raw)]
buffer=io.StringIO()
with contextlib.redirect_stdout(buffer):ns=runpy.run_path(sys.argv[0],run_name='__main__')
scorer=module('qasper_evaluator',root/'reference/qasper_evaluator.py')
gold=scorer.get_answers_and_evidence(data,False)
ordered=[q['question_id'] for p in data.values() for q in p['qas']]
labels={q['id']:q for q in rows(root/'prepared/qasper-queries.jsonl')}
normal=lambda s:' '.join(s.split())
result={}
for name in ['random','first','tfidf']:
 pred=ns[name+'_paragraphs'];assert len(pred)==len(ordered)==1005
 official=[];strict=[];per=[]
 for qid,paragraphs in zip(ordered,pred):
  f1=max(scorer.paragraph_f1_score(paragraphs,g['evidence']) for g in gold[qid])
  q=labels[qid];normalized={normal(p) for p in paragraphs}
  valid=[a for a in q['annotations'] if a['valid']]
  coverage=max((sum(normal(e['text']) in normalized for e in a['evidence'])/len(a['evidence']) for a in valid),default=None)
  if coverage is not None:strict.append(coverage)
  official.append(f1);per.append({'id':qid,'predicted_evidence':paragraphs,'official_evidence_f1':f1,'strict_coverage':coverage})
 result[name]={'questions':1005,'evidence_f1':sum(official)/1005,'strict_questions':len(strict),'strict_complete':sum(x==1 for x in strict),'strict_coverage_macro':sum(strict)/len(strict),'output':'one original full_text paragraph per question; not equal budget/chunk count to Echo'}
 (root/f'analysis/qasper-{name}-baseline.jsonl').write_text(''.join(json.dumps(x,ensure_ascii=False)+'\n' for x in per),encoding='utf8')
receipt={'status':'actual_official_baseline_predictions_rescored','scikit_learn':importlib.metadata.version('scikit-learn'),'source_sha256':hashlib.sha256((root/'reference/qasper_heuristics.py').read_bytes()).hexdigest(),'original_script_stdout':buffer.getvalue(),'caveat':'Original heuristic compute_paragraph_f1 returns zero early when any earlier annotation has no intersection; comparison uses unchanged predicted paragraphs rescored by official evaluator max-over-annotations, not that helper.','results':result}
(root/'analysis/qasper-official-baselines.json').write_text(json.dumps(receipt,indent=2)+'\n',encoding='utf8');print(json.dumps(receipt))
