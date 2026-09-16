import argparse, ctypes, hashlib, pathlib, sys
from ctypes import wintypes
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives import serialization

class Blob(ctypes.Structure):
    _fields_ = [('size',wintypes.DWORD),('data',ctypes.POINTER(ctypes.c_ubyte))]
def dpapi(data, decrypt=False):
    buffer=ctypes.create_string_buffer(data)
    source=Blob(len(data),ctypes.cast(buffer,ctypes.POINTER(ctypes.c_ubyte)))
    out=Blob()
    if decrypt:
        ok=ctypes.windll.crypt32.CryptUnprotectData(ctypes.byref(source),None,None,None,None,1,ctypes.byref(out))
    else:
        ok=ctypes.windll.crypt32.CryptProtectData(ctypes.byref(source),'Codex comparison capture key',None,None,None,1,ctypes.byref(out))
    if not ok: raise ctypes.WinError()
    try: return ctypes.string_at(out.data,out.size)
    finally: ctypes.windll.kernel32.LocalFree(out.data)
def initialize(root):
    root.mkdir(parents=True,exist_ok=True)
    if (root/'capture-private.dpapi').exists():
        private=serialization.load_pem_private_key(dpapi((root/'capture-private.dpapi').read_bytes(),True),None)
    else:
        private=rsa.generate_private_key(public_exponent=65537,key_size=3072)
        raw=private.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption())
        (root/'capture-private.dpapi').write_bytes(dpapi(raw))
    public=private.public_key().public_bytes(serialization.Encoding.PEM,serialization.PublicFormat.SubjectPublicKeyInfo)
    (root/'capture-public.pem').write_bytes(public)
    assert serialization.load_pem_private_key(dpapi((root/'capture-private.dpapi').read_bytes(),True),None).public_key().public_numbers()==private.public_key().public_numbers()
    print('Capture encryption key verified; public SHA256='+hashlib.sha256(public).hexdigest())
if __name__=='__main__': initialize(pathlib.Path(sys.argv[1]))
