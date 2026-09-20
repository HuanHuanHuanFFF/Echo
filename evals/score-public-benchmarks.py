import sys,json,pathlib,importlib.util,importlib.metadata,hashlib,math
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parent/'lib'))
from public_score_validation import unique_rows, fixed_run
root=pathlib.Path(sys.argv[1]).resolve();task=sys.argv[2]
sys.path.insert(0,str(root/'scoring-tools'))
def load_module(name,file):
    spec=importlib.util.spec_from_file_location(name,file);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
def rows(file):
    with open(file,encoding='utf8') as f:
        for line in f:
            if line.strip():yield json.loads(line)
def sha(file):
    with open(file,'rb') as f: return hashlib.file_digest(f,'sha256').hexdigest()
def bindings(files):return {str(pathlib.Path(f).relative_to(root)).replace(chr(92),'/'):sha(f) for f in files}
out=pathlib.Path(sys.argv[3]).resolve() if len(sys.argv)>3 else root/'analysis'
assert out.is_relative_to(root), "Output directory must stay in benchmark root"
out.mkdir(parents=True,exist_ok=True)
assert not (out/f'{task}-official-score.json').exists(), "Refuse overwrite; choose a new scoring output directory"
implementation={'adapter_sha256':sha(__file__),'validator_sha256':sha(pathlib.Path(__file__).resolve().parent/'lib/public_score_validation.py'),'python':sys.version}
if task=='qasper':
    scorer=load_module('official_qasper',root/'reference/qasper_evaluator.py')
    data={d['id']:d for d in rows(root/'data/qasper-dev.jsonl')}
    docs={d['id']:d for d in rows(root/'prepared/qasper-docs.jsonl')}
    gold=scorer.get_answers_and_evidence(data,False)
    text_gold=scorer.get_answers_and_evidence(data,True)
    summary={};per_question=[]
    for arm in ['p0','p1','p2']:
        prediction={};old={}
        for r in unique_rows(rows(root/f'qasper/{arm}-results.jsonl'),gold):
            selected=r['score']['selected_paragraphs']
            paragraphs=docs[r['paper_id']]['paragraphs']
            evidence=[paragraphs[i]['text'] for i in selected]
            prediction[r['id']]={'answer':'','evidence':evidence}
            old[r['id']]=r['score']['official_formula_evidence_f1']
        assert set(prediction)==set(gold) and len(prediction)==1005
        evaluation=scorer.evaluate(gold,prediction)
        text_evaluation=scorer.evaluate(text_gold,prediction)
        mismatches=[]
        for q in gold:
            value=max(scorer.paragraph_f1_score(prediction[q]['evidence'],g['evidence']) for g in gold[q])
            if not math.isclose(value,old[q],abs_tol=1e-12):mismatches.append(q)
            per_question.append({'arm':arm,'id':q,'official_evidence_f1':value})
        assert not mismatches,mismatches
        summary[arm]={'questions':1005,'raw_all_evidence_f1':evaluation['Evidence F1'],'text_evidence_only_f1':text_evaluation['Evidence F1'],'missing':evaluation['Missing predictions'],'local_formula_all_rows_equal':True,'result_sha256':sha(root/f'qasper/{arm}-results.jsonl')}
    receipt={'metric':'Official QASPER paragraph Evidence F1; blank answer placeholders used only to satisfy evaluator input; no Answer F1 reported','scorer_sha256':sha(root/'reference/qasper_evaluator.py'),'bindings':bindings([root/'data/qasper-dev.jsonl',root/'prepared/audit.json',root/'embedding-plan.json',root/'conversion-manifest.json']+[root/f'qasper/{arm}-summary.json' for arm in ['p0','p1','p2']]),'summary':summary}
    (out/'qasper-official-per-question.jsonl').write_text(''.join(json.dumps(x)+'\n' for x in per_question),encoding='utf8')
    receipt['implementation']=implementation
    receipt['per_question_bindings']=bindings([out/'qasper-official-per-question.jsonl'])
    (out/'qasper-official-score.json').write_text(json.dumps(receipt,indent=2)+'\n',encoding='utf8')
    print(json.dumps(receipt))
else:
    import pytrec_eval,pyndeval
    official=None if task=='du' else load_module('official_freshstack',root/'reference/freshstack_metrics.py')
    if task=='du':
        qrels={}
        for r in rows(root/'data/du-qrels.jsonl'):qrels.setdefault(r['qid'],{})[r['pid']]=r['score']
        queries=list(rows(root/'data/du-queries.jsonl'));expected={r['id'] for r in queries}
    else:
        assert task in ['langchain','godot'];qrels={};nuggets={};mapping={}
        for q in rows(root/f'data/freshstack-{task}-queries.jsonl'):
            qid=q['query_id'];mapping[qid]=[]
            for nugget in q['nuggets']:
                nid=nugget['_id'];mapping[qid].append(nid)
                values={d:0 for d in nugget['non_relevant_corpus_ids']}
                values.update({d:1 for d in nugget['relevant_corpus_ids']});nuggets[nid]=values
                for doc,rel in values.items():qrels.setdefault(qid,{})[doc]=qrels.setdefault(qid,{}).get(doc,0)+rel
        expected=set(mapping)
    expected=sorted(expected)
    assert set(qrels)==set(expected), 'Query/qrels IDs mismatch'
    corpus_file=root/'data'/('du-corpus.jsonl' if task=='du' else f'freshstack-{task}-corpus.jsonl')
    corpus_ids={str(r.get('_id',r.get('id'))) for r in rows(corpus_file)}
    result={}
    for k in [30,10]:
        run=fixed_run(rows(root/f'fixed/{task}-rrf{k}.jsonl'),expected,corpus_ids,k)
        ev=pytrec_eval.RelevanceEvaluator(qrels,{'ndcg_cut.10','recall.10,50','recip_rank'})
        evaluated=ev.evaluate(run)
        raw={q:{name:evaluated.get(q,{}).get(name,0) for name in ['ndcg_cut_10','recall_10','recall_50','recip_rank']} for q in expected}
        metrics={name:sum(raw.get(q,{}).get(name,0) for q in expected)/len(expected) for name in ['ndcg_cut_10','recall_10','recall_50','recip_rank']}
        cut10={q:dict(list(sorted(ds.items(),key=lambda x:x[1],reverse=True))[:10]) for q,ds in run.items()}
        rank10=pytrec_eval.RelevanceEvaluator(qrels,{'recip_rank'}).evaluate(cut10)
        metrics['MRR@10']=sum(rank10.get(q,{}).get('recip_rank',0) for q in expected)/len(expected)
        metrics['Hit@10']=sum(any(qrels[q].get(d,0)>0 for d in cut10[q]) for q in expected)/len(expected)
        if task!='du':
            metrics.update(official.alpha_ndcg(nuggets,mapping,run,[10]))
            metrics.update(official.coverage(nuggets,mapping,run,[10,20]))
            metrics.update(official.recall(qrels,run,[10,50]))
        result['rrf'+str(k)]={'questions':len(expected),'metrics':metrics}
        (out/f'{task}-rrf{k}-per-question.json').write_text(json.dumps(raw,ensure_ascii=False)+'\n',encoding='utf8')
    receipt={'scope':task,'versions':{x:importlib.metadata.version(x) for x in ['pyndeval','pytrec-eval-terrier','numpy','scipy']},'official_scorer_sha256':sha(root/'reference/freshstack_metrics.py'),'rank_export':'Unique descending rank_score preserves Echo candidate order; original RRF scores retained in runfile.','bindings':bindings([corpus_file,root/'embedding-plan.json',root/'conversion-manifest.json',root/f'fixed/{task}-index.json',root/f'fixed/{task}-run-receipt.json',root/f'fixed/{task}.sqlite',root/'data'/('du-queries.jsonl' if task=='du' else f'freshstack-{task}-queries.jsonl')]+[root/f'fixed/{task}-rrf{k}.jsonl' for k in [30,10]]+([root/'data/du-qrels.jsonl'] if task=='du' else [])),'results':result}
    if task=='du':
        del receipt['official_scorer_sha256']
        protocol=root/'reference/c-mteb-retrieval-task-receipt.json'
        receipt['official_protocol']=json.loads(protocol.read_text(encoding='utf8'))
        receipt['official_protocol']['executed']=False
        receipt['metric_implementation']={'package':'pytrec-eval-terrier','version':importlib.metadata.version('pytrec-eval-terrier'),'metric':'ndcg_cut.10','meaning':'pytrec_eval implements C-MTEB dev nDCG@10 on unchanged binary qrels; not the complete MTEB pipeline'}
        module_files=[pathlib.Path(pytrec_eval.__file__)]
        for module in ['pytrec_eval_ext','_pytrec_eval']:
            spec=importlib.util.find_spec(module)
            if spec and spec.origin:module_files.append(pathlib.Path(spec.origin))
        receipt['metric_implementation']['file_bindings']=bindings(module_files)
        receipt['bindings'].update(bindings([protocol,root/'reference/c-mteb-retrieval-task.py']))
    receipt['implementation']=implementation
    receipt['per_question_bindings']=bindings([out/f'{task}-rrf{k}-per-question.json' for k in [30,10]])
    (out/f'{task}-official-score.json').write_text(json.dumps(receipt,indent=2)+'\n',encoding='utf8');print(json.dumps(receipt))
