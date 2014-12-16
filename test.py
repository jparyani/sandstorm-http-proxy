import capnp
import sys
sys.path.append('/opt/sandstorm/latest/usr/include/sandstorm/')
import web_session_capnp
import hack_session_capnp
import os
import requests


class WebSession(web_session_capnp.WebSession.Server):
  def get(self, path, _context, **kwargs):
    resp = requests.get('http://google.com' + path)
    _context.results.from_dict({'content': {'body': {'bytes': resp.text.encode(encoding='UTF-8')}}})


class Server(hack_session_capnp.HackSessionContext.Server):
  def send(self, *args, **kwargs):
    print args, kwargs

  def getApiEndpoint(self, *args, **kwargs):
    return 'http://google.com'

  def getUIViewForToken(self, token, **kwargs):
    return WebSession()

if os.path.exists('/tmp/sandstorm-api'):
  os.unlink('/tmp/sandstorm-api')

s = capnp.TwoPartyServer('unix:/tmp/sandstorm-api', lambda _: Server())
s.run_forever()
