/**
 * Copyright 2020 Comunidad PAS and 2016 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for t`he specific language governing permissions and
 * limitations under the License.
 */
'use strict';

// Modules imports
const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const request = require('request');


// Load config file
const config = require('./config.json');

const PORT = process.env.PORT || '8080'
const HOST = '0.0.0.0'

// Firebase Setup
const admin = require('firebase-admin');
const serviceAccount = require('./service-account.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
});

// Instagram OAuth 2 setup
const credentials = {
  client: {
    id: config.pco.clientId,
    secret: config.pco.clientSecret
  },
  auth: {
    tokenHost: 'https://api.planningcenteronline.com',
    tokenPath: '/oauth/token'
  }
};
const oauth2 = require('simple-oauth2').create(credentials);

// Path to the OAuth handlers.
const OAUTH_REDIRECT_PATH = '/redirect';
const OAUTH_CALLBACK_PATH = '/pco-callback';
const OAUTH_MOBILE_REDIRECT_PATH = '/pco-mobile-redirect';
const OAUTH_MOBILE_CALLBACK_PATH = '/pco-mobile-callback';
const OAUTH_CODE_EXCHANGE_PATH = '/pco-mobile-exchange-code';

// Custom URI scheme for Android and iOS apps.
const APP_CUSTOM_SCHEME = 'pco-sign-in';

// Instagram scopes requested.
const OAUTH_SCOPES = 'people services';

// ExpressJS setup
const app = express();
app.enable('trust proxy');
//app.use(express.static('public'));
app.use(cookieParser());

/**
 * Redirects the User to the Instagram authentication consent screen. Also the 'state' cookie is set for later state
 * verification.
 */
app.get(OAUTH_REDIRECT_PATH, (req, res) => {
  const state = req.cookies.state || crypto.randomBytes(20).toString('hex');
  //console.log('Setting state cookie for verification:', state);
  const secureCookie = req.get('host').indexOf('localhost:') !== 0;
  //console.log('Need a secure cookie (i.e. not on localhost)?', secureCookie);
  res.cookie('state', state, {maxAge: 3600000, secure: secureCookie, httpOnly: true});
  const redirectUri = oauth2.authorizationCode.authorizeURL({
    redirect_uri: `${req.protocol}://${req.get('host')}${OAUTH_CALLBACK_PATH}`,
    scope: OAUTH_SCOPES,
    state: state
  });
  //console.log('Redirecting to:', redirectUri);
  res.redirect(redirectUri);
});

function getUserData(bearerToken) {
  return new Promise((resolve, reject) => {
    request('https://api.planningcenteronline.com/people/v2/me?include=emails',{
      'auth': {
        'bearer': bearerToken,
      },
      'json': true 
      }, (err, res, body) => {

        if (err) { reject(err); }
        resolve(body)
    });
  });
}

/**
 * Exchanges a given Instagram auth code passed in the 'code' URL query parameter for a Firebase auth token.
 * The request also needs to specify a 'state' query parameter which will be checked against the 'state' cookie to avoid
 * Session Fixation attacks.
 * This is meant to be used by Web Clients.
 */
app.get(OAUTH_CALLBACK_PATH, async (req, res) => {
  //console.log('Received state cookie:', req.cookies.state);
  //console.log('Received state query parameter:', req.query.state);
  if (!req.cookies.state) {
    res.status(400).send('State cookie not set or expired. Maybe you took too long to authorize. Please try again.');
  } else if (req.cookies.state !== req.query.state) {
    res.status(400).send('State validation failed');
  }
  //console.log('Received auth code:', req.query.code);
  oauth2.authorizationCode.getToken({
    code: req.query.code,
    redirect_uri: `${req.protocol}://${req.get('host')}${OAUTH_CALLBACK_PATH}`
  }).then(async results => {
    //console.log('Auth code exchange result received:', results);
    // We have an Instagram access token and the user identity now.
    const accessToken = results.access_token;
    const body = await getUserData(accessToken)
    const pcoId = body["data"]["id"];
    const pcoName = body["data"]["attributes"]["name"];
    const pcoProfilePic = body["data"]["attributes"]["avatar"];
    const pcoEmail = body["included"][0]["type"] == "Email"?body["included"][0]["attributes"]["address"]:null
    if (body["meta"]["parent"]["id"] != config.app.pcoOrgId) {
      res.send("Unknown parent org!")
    }
    // Create a Firebase account and get the Custom Auth Token.
    createFirebaseAccount(pcoId, pcoName, pcoProfilePic, accessToken, pcoEmail).then(firebaseToken => {
          // Serve an HTML page that signs the user in and updates the user profile.
      res.redirect(config.app.loginRedirect + firebaseToken)
    });
    
  });
});

/**
 * Passes the auth code to your Mobile application by redirecting to a custom scheme URL. This serves as a fallback in
 * case App Link/Universal Links are not supported on the device.
 * Native Mobile apps should use this callback.
 */
app.get(OAUTH_MOBILE_REDIRECT_PATH, (req, res) => {
  res.redirect(`${APP_CUSTOM_SCHEME}:/${OAUTH_MOBILE_CALLBACK_PATH}?${req.originalUrl.split('?')[1]}`);
});

/**
 * Exchanges a given Instagram auth code passed in the 'code' URL query parameter for a Firebase auth token.
 * This endpoint is meant to be used by native mobile clients only since no Session Fixation attacks checks are done.
 */
app.get(OAUTH_CODE_EXCHANGE_PATH, (req, res) => {
  //console.log('Received auth code:', req.query.code);
  oauth2.authCode.getToken({
    code: req.query.code,
    redirect_uri: `${req.protocol}://${req.get('host')}${OAUTH_MOBILE_CALLBACK_PATH}`
  }).then(results => {
    //console.log('Auth code exchange result received:', results);

    // Create a Firebase Account and get the custom Auth Token.
    createFirebaseAccount(results.user.id, results.user.full_name,
        results.user.profile_picture, firebaseToken).then(firebaseToken => {
      // Send the custom token, access token and profile data as a JSON object.
      res.send({
        firebaseCustomToken: firebaseToken,
        pcoAccessToken: results.access_token,
        photoURL: results.user.profile_picture,
        displayName: results.user.full_name
      });
    });
  });
});


/**
 * Creates a Firebase account with the given user profile and returns a custom auth token allowing
 * signing-in this account.
 * Also saves the accessToken to the datastore at /instagramAccessToken/$uid
 *
 * @returns {Promise<string>} The Firebase custom auth token in a promise.
 */
function createFirebaseAccount(pcoId, displayName, photoURL, accessToken, email) {
  // The UID we'll assign to the user.
  const uid = `pco:${pcoId}`;

  // Create or update the user account.
  const userCreationTask = admin.auth().updateUser(uid, {
    displayName: displayName,
    photoURL: photoURL
  }).catch(error => {
    // If user does not exists we create it.
    if (error.code === 'auth/user-not-found') {
    // Create the user in the db
    admin.database().ref(`/users/${uid}`)
    .set({
      public:  {
        about: {
          userName: displayName,
          profileImage: photoURL,
          phoneNumber: '',
          biography: '',
          tag: ''
        }
      },
      private:  {
        admin: false,
        visibilityGroup: 'normal'
      }
    });
      return admin.auth().createUser({
        uid: uid,
        displayName: displayName,
        photoURL: photoURL,
        email: email,
        emailVerified: true
      }).catch(error => {
        console.error("An error occurred while creating a user:\n" + error)
      })
    }
    throw error;
  });

  // Save the access token to the Firebase Realtime Database.
  const databaseTaskSet = admin.database().ref(`/users/${uid}/private/pcoAccessToken`)
      .set(accessToken);

  // Wait for all async task to complete then generate and return a custom auth token.
  return Promise.all([userCreationTask, databaseTaskSet]).then(() => {
    // Create a Firebase custom auth token.
    const token = admin.auth().createCustomToken(uid);
    //console.log('Created Custom token for UID "', uid, '" Token:', token);
    return token;
  });
}

// Start the server
var server = app.listen(PORT, HOST);
