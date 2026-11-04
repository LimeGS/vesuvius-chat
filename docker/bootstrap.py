"""Download fixed public model revisions; never packages Discord data or credentials."""
import json
import os
from pathlib import Path

MODELS = {
    'intfloat/multilingual-e5-base': 'd128750597153bb5987e10b1c3493a34e5a4502a',
    'Helsinki-NLP/opus-mt-es-en': 'c96e2c5399ebfae4fc43d9669556b9afa74bb69d',
    'cross-encoder/mmarco-mMiniLMv2-L12-H384-v1': '1427fd652930e4ba29e8149678df786c240d8825',
    'cross-encoder/ms-marco-MiniLM-L12-v2': '7b0235231ca2674cb8ca8f022859a6eba2b1c968',
}


def models(bundle):
    from huggingface_hub import snapshot_download
    for name, revision in MODELS.items():
        destination = bundle / 'models' / name.replace('/', '--')
        marker = destination / '.ready'
        if marker.exists() and marker.read_text() == revision: continue
        snapshot_download(name, revision=revision, local_dir=destination,
                          ignore_patterns=['*.h5', '*.msgpack', '*.onnx', 'onnx/*', 'openvino/*', '*.ot', '*.tflite'])
        marker.write_text(revision)
    (bundle / 'handles.json').write_text('{}')


if __name__ == '__main__':
    import time
    bundle = Path(os.environ.get('RAG_BUNDLE_DIR', '/data/bundle'))
    while not (bundle / 'index/manifest.json').exists(): time.sleep(2)
    os.execvp('python', ['python', '-B', '/app/rag/server.py'])
