const { CookieKonnector, log } = require('cozy-konnector-libs')
const qs = require('querystring')

// const VENDOR = 'EDF'
const baseUrl =
  'https://espace-client.edf.fr/connexion/mon-espace-client/?realm=/INTERNET#login/'

class EdfConnector extends CookieKonnector {
  async fetch() {
    log('info', 'run')
    await this.request(baseUrl)
    const resp = await this.request(
      'https://particulier.edf.fr/fr/accueil/espace-client/selecteur-contrat.html?goto=https%3A%2F%2Fparticulier.edf.fr%2fbin%2fedf_rc%2fservlets%2fsasServlet%3Fprocessus=TDB%26forceAuth=true',
      { resolveWithFullResponse: true }
    )

    const authData = qs.parse(resp.request.uri.href)
    const postUrl = unescape(authData.goto)
    const postData = qs.parse(postUrl.split('?').pop())
    console.log(postData, 'postData')
    // { 'https://espace-client.edf.fr/sso/oauth2/INTERNET/authorize?service': 'X2',
    //   response_type: 'code',
    //     scope: 'openid email infotech',
    //       client_id: 'SiteCP',
    //         state: '3hp7fXUXlZqNbRRg2E82VKaHOD8',
    //           redirect_uri:
    //           'https://particulier.edf.fr/fr/accueil/espace-client/moduleopenidc.html',
    //             nonce: 'cuq3gUDe3kDJXqAHy1bjuJKnvOCNefjaQa4PLlLReFE',
    //               response_mode: 'form_post' }

    // post url to construct :
    // "url": "https://espace-client.edf.fr/sso/json/authenticate?realm=/INTERNET&service=X2&goto=https%3A%2F%2Fespace-client.edf.fr%2Fsso%2Foauth2%2FINTERNET%2Fauthorize%3Fservice%3DX2%26response_type%3Dcode%26scope%3Dopenid%2520email%2520infotech%26client_id%3DSiteCP%26state%3DPvx0dTBwHyAF0hWy1Ln8m99s63w%26redirect_uri%3Dhttps%253A%252F%252Fparticulier.edf.fr%252Ffr%252Faccueil%252Fespace-client%252Fmoduleopenidc.html%26nonce%3D8qILrQToCq_b1Ocoupyr9B39C3EXD2_JohhFxgKi0sA%26response_mode%3Dform_post&authIndexType=service&authIndexValue=X2",
    const auth = await this.request.post(
      `https://espace-client.edf.fr/sso/json/authenticate?realm=/INTERNET`,
      {
        qs: postData
      }
    )
    // result
    // {
    //   "authId": "eyAidHlwIjogIkpXVCIsICJhbGciOiAiSFMyNTYiIH0.eyAib3RrIjogInRiM3Q3czhpbDF0amxjOHJicXBlNG80OTZ0IiwgInJlYWxtIjogIm89aW50ZXJuZXQsb3U9c2VydmljZXMsZGM9b3BlbmFtLGRjPWVkZixkYz1mciIsICJzZXNzaW9uSWQiOiAiQVFJQzV3TTJMWTRTZmN5bXRob0o4WTU1MmpVVnFIVEt2a3RBNVo0MFRRblpiZmMuKkFBSlRTUUFDTURJQUFsTkxBQk10TnpBME16WXlNemsxTmpjMU5UQXdOalk0QUFKVE1RQUNNREUuKiIgfQ.DEIJfFNwKYV-Wojl__H3DcRe5oRmbl0Xl_NiUj4nJ_w",
    //   "template": "",
    //   "stage": "UsernameAuth2",
    //   "header": "#TO BE SUBSTITUTED#",
    //   "callbacks": [
    //     {
    //       "type": "NameCallback",
    //       "output": [
    //         {
    //           "name": "prompt",
    //           "value": "#USERNAME#"
    //         }
    //       ],
    //       "input": [
    //         {
    //           "name": "IDToken1",
    //           "value": ""
    //         }
    //       ]
    //     },
    //     {
    //       "type": "TextOutputCallback",
    //       "output": [
    //         {
    //           "name": "message",
    //           "value": " "
    //         },
    //         {
    //           "name": "messageType",
    //           "value": "2"
    //         }
    //       ]
    //     },
    //     {
    //       "type": "TextOutputCallback",
    //       "output": [
    //         {
    //           "name": "message",
    //           "value": "https://particulier.edf.fr/fr/accueil/connexion/creer-espace-client.html"
    //         },
    //         {
    //           "name": "messageType",
    //           "value": "2"
    //         }
    //       ]
    //     },
    //     {
    //       "type": "TextOutputCallback",
    //       "output": [
    //         {
    //           "name": "message",
    //           "value": "#BADEMAIL#"
    //         },
    //         {
    //           "name": "messageType",
    //           "value": "2"
    //         }
    //       ]
    //     }
    //   ]
    // }

    auth.callbacks[0].input[0].value = '<THE MAIL>'
    const afterEmail = await this.request.post(
      `https://espace-client.edf.fr/sso/json/authenticate?realm=/INTERNET`,
      {
        qs: postData,
        body: auth
      }
    )

    // {
    //   "authId": "eyAidHlwIjogIkpXVCIsICJhbGciOiAiSFMyNTYiIH0.eyAib3RrIjogImY4ODdxNjZvZGlrZG9tMXFmdTBwOHNicm1vIiwgInJlYWxtIjogIm89aW50ZXJuZXQsb3U9c2VydmljZXMsZGM9b3BlbmFtLGRjPWVkZixkYz1mciIsICJzZXNzaW9uSWQiOiAiQVFJQzV3TTJMWTRTZmN5d0ZlZWt0Rno4X3lFVk0tLWdHUDBJRUZSM181dFVWMUUuKkFBSlRTUUFDTURJQUFsTkxBQk14TXpnME5UZzNOekk0TWpreU16TTBPVEl4QUFKVE1RQUNNREUuKiIgfQ.OmFE0JrNsIPmat_Zj4iGpIfiInWORvqQ-vS-yGtzOIE",
    //   "template": "",
    //   "stage": "CheckPASAuth1",
    //   "header": "",
    //   "callbacks": [
    //     {
    //       "type": "NameCallback",
    //       "output": [
    //         {
    //           "name": "prompt",
    //           "value": "29811848"
    //         }
    //       ],
    //       "input": [
    //         {
    //           "name": "IDToken1",
    //           "value": "29811848"
    //         }
    //       ]
    //     }
    //   ]
    // }

    // devrait envoyer
    // {"authId":"eyAidHlwIjogIkpXVCIsICJhbGciOiAiSFMyNTYiIH0.eyAiYXV0aEluZGV4VmFsdWUiOiAiWDIiLCAib3RrIjogImVjdTllbXYyZjc0aG9lcGFwMTU4NjRiaWQiLCAiYXV0aEluZGV4VHlwZSI6ICJzZXJ2aWNlIiwgInJlYWxtIjogIm89aW50ZXJuZXQsb3U9c2VydmljZXMsZGM9b3BlbmFtLGRjPWVkZixkYz1mciIsICJzZXNzaW9uSWQiOiAiQVFJQzV3TTJMWTRTZmN4aFZHZVZHVUtzQk9nRHhBRF9nZmZ3QjZmVzNTeUxrTGcuKkFBSlRTUUFDTURJQUFsTkxBQk0wT1RjME5EZ3lNamt6TmpjeE1qSXdNamMzQUFKVE1RQUNNREUuKiIgfQ.x0FuEbfT20muQ-6NTIpQp1I8DfucsyLW3qz41bArOKo","template":"","stage":"CheckPASAuth1","header":"","callbacks":[{"type":"NameCallback","output":[{"name":"prompt","value":"29811848"}],"input":[{"name":"IDToken1","value":"eyAidHlwIjogIkpXVCIsICJraWQiOiAicGFzX3NlY3JldF9rZXlfMjAxOTEyMjEiLCAiYWxnIjogIkhTMjU2IiB9.eyAic3ViIjogIjI5ODExODQ4IiwgImlhdCI6IDE1NTAwNjQ0MzQsICJqdGkiOiAibWV6TVRtT3hpUDNoWXcvQ0x4T09FczRZczJFPSIgfQ.mp0d0rplG_Ddy5snW22npEh7bBBk7ob8Ltb-tY3b82w"}]}]}

    console.log(JSON.stringify(afterEmail, null, 2))
  }

  async testSession() {
    return true
  }
}

const connector = new EdfConnector({
  debug: true,
  cheerio: false,
  json: true,
  jar: true
})

connector.run()
