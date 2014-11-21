import capnp
import sys
sys.path.append('/opt/sandstorm/latest/usr/include/sandstorm/')
import hack_session_capnp
import os
import requests


class Server(hack_session_capnp.HackSessionContext.Server):
  def send(self, *args, **kwargs):
    print args, kwargs
  def getApiEndpoint(self, *args, **kwargs):
    return 'http://google.com'
  def httpGet(self, url, **kwargs):
    resp = requests.get(url)
    return (resp.headers['content-type'], resp.text.encode(encoding='UTF-8'))

if os.path.exists('/tmp/sandstorm-api'):
  os.unlink('/tmp/sandstorm-api')

s = capnp.TwoPartyServer('unix:/tmp/sandstorm-api', lambda _: Server())
s.run_forever()
