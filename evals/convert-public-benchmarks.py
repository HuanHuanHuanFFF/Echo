import sys,json,pathlib,tarfile,hashlib,collections,importlib.metadata
root=pathlib.Path(sys.argv[1]).resolve()
sys.path.insert(0,str(root/'tooling'))
import pyarrow.parquet as pq
out=root/'data';out.mkdir(exist_ok=True)
receipt=[]
def save(name,records):
    dst=out/name
    if dst.exists(): raise RuntimeError('Refuse overwrite '+str(dst))
    h=hashlib.sha256(); n=0; chars=0; lengths=[]
    with dst.open('wb') as f:
        for row in records:
            b=(json.dumps(row,ensure_ascii=False,separators=(',',':'))+'\n').encode('utf8')
            f.write(b);h.update(b);n+=1
            if isinstance(row.get('text'),str): chars+=len(row['text']);lengths.append(len(row['text']))
    rec={'file':'data/'+name,'sha256':h.hexdigest(),'rows':n,'text_chars':chars}
    if lengths: rec['lengths']={'min':min(lengths),'max':max(lengths),'over_8000':sum(x>8000 for x in lengths),'over_16000':sum(x>16000 for x in lengths)}
    receipt.append(rec);print(json.dumps(rec),flush=True)
def rows(relative):
    p=root/'downloads'/relative
    pf=pq.ParquetFile(p)
    for batch in pf.iter_batches(batch_size=1000):
        yield from batch.to_pylist()
with tarfile.open(root/'downloads/qasper-train-dev-v0.3.tgz','r:gz') as t:
    member=t.getmember('qasper-dev-v0.3.json')
    obj=json.load(t.extractfile(member))
    save('qasper-dev.jsonl',({'id':k,**v} for k,v in obj.items()))
    print(json.dumps({'qasper_questions':sum(len(p['qas']) for p in obj.values()),'papers':len(obj)}),flush=True)
for topic in ['langchain','godot']:
    save('freshstack-'+topic+'-corpus.jsonl',rows('freshstack/corpus-oct-2024/'+topic+'/train-00000-of-00001.parquet'))
    save('freshstack-'+topic+'-queries.jsonl',rows('freshstack/queries-oct-2024/'+topic+'/test-00000-of-00001.parquet'))
save('du-corpus.jsonl',rows('C-MTEB/DuRetrieval/data/corpus-00000-of-00001-19b9e924cb33e4d5.parquet'))
save('du-queries.jsonl',rows('C-MTEB/DuRetrieval/data/queries-00000-of-00001-7c7edb40be6b560c.parquet'))
save('du-qrels.jsonl',rows('C-MTEB/DuRetrieval-qrels/data/dev-00000-of-00001-d3c385852a7c0c9d.parquet'))
(root/'conversion-manifest.json').write_text(json.dumps({'python':sys.version,'pyarrow':importlib.metadata.version('pyarrow'),'files':receipt},indent=2)+'\n',encoding='utf8')
