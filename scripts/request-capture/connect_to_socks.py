"""Loopback HTTP CONNECT -> existing SOCKS5 tunnel. No payload logging."""
import asyncio, argparse, ipaddress, struct

async def pipe(reader, writer):
    try:
        while True:
            data=await reader.read(65536)
            if not data: break
            writer.write(data); await writer.drain()
    except (OSError,asyncio.CancelledError): pass
    finally:
        try: writer.close()
        except OSError: pass

async def handle(reader, writer):
    remote_writer=None
    try:
        header=await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'),15)
        if len(header)>16384: raise ValueError()
        first=header.split(b'\r\n',1)[0].decode('ascii').split()
        if len(first)!=3 or first[0]!='CONNECT': raise ValueError()
        host, port=first[1].rsplit(':',1); port=int(port)
        host=host.lower().rstrip('.')
        allowed = host == 'api.ipify.org' or any(host == d or host.endswith('.'+d) for d in ('chatgpt.com','openai.com','oaistatic.com','oaiusercontent.com'))
        if not allowed or port!=443: raise ValueError()
        remote_reader,remote_writer=await asyncio.wait_for(asyncio.open_connection(ARGS.socks_host,ARGS.socks_port),15)
        remote_writer.write(b'\x05\x01\x00'); await remote_writer.drain()
        if await remote_reader.readexactly(2)!=b'\x05\x00': raise OSError()
        domain=host.encode('idna')
        remote_writer.write(b'\x05\x01\x00\x03'+bytes([len(domain)])+domain+struct.pack('!H',port)); await remote_writer.drain()
        reply=await remote_reader.readexactly(4)
        if reply[1]!=0: raise OSError()
        length={1:4,4:16}.get(reply[3])
        if reply[3]==3: length=(await remote_reader.readexactly(1))[0]
        if length is None: raise OSError()
        await remote_reader.readexactly(length+2)
        writer.write(b'HTTP/1.1 200 Connection Established\r\n\r\n'); await writer.drain()
        await asyncio.gather(pipe(reader,remote_writer),pipe(remote_reader,writer))
    except (ValueError,OSError,UnicodeError,asyncio.TimeoutError,asyncio.IncompleteReadError,asyncio.LimitOverrunError):
        try: writer.write(b'HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'); await writer.drain()
        except OSError: pass
    finally:
        writer.close()
        if remote_writer: remote_writer.close()

async def main():
    server=await asyncio.start_server(handle,'127.0.0.1',ARGS.port,limit=16384)
    async with server: await server.serve_forever()

if __name__=='__main__':
    parser=argparse.ArgumentParser(); parser.add_argument('--port',type=int,default=18890); parser.add_argument('--socks-host',default='172.30.80.1'); parser.add_argument('--socks-port',type=int,default=11080); ARGS=parser.parse_args(); asyncio.run(main())
