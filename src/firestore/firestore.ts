import * as FQLParser from '../../parser/parser';
import {DocumentSnapshot, QueryDocumentSnapshot, QuerySnapshot, CollectionReference} from '@google-cloud/firestore';

import {Document} from "./document";
import * as auth from "../auth";
import * as FirebaseAdmin from "firebase-admin";
import {QueryResult} from "./query-result";

export let unsubscribeListener;

export type onChangeListener = (result: QueryResult, error: Error) => void;

/**
 * Runs a query against Firebase database
 * @param queryString The FiremanQL query
 * @param onChangeListener The optional listener for changes (if this is provided then nothing is returned in the promise)
 */
export const query = async (queryString: string, onChangeListener?: onChangeListener): Promise<QueryResult | void> => {
  try {
    const queryComponents = FQLParser.parse(queryString);
    const queryType: QueryType = getQueryType(queryComponents);
    const {reference, specificProperties, documentExpression} = parseQuery(queryComponents);

    if (onChangeListener) {
      setListener(queryType, reference, specificProperties, onChangeListener);
    } else {
      const result = await getResult(queryString, queryType, reference, specificProperties);
      return new QueryResult(result, documentExpression);
    }
  } catch (e) {
    onChangeListener && onChangeListener(null, e);
    return Promise.reject(e);
  }
};

function setListener(queryType: QueryType, reference: any, specificProperties: string[], onChangeListener: onChangeListener) {
  if (queryType === QueryType.DOCUMENT) {
    unsubscribeListener = reference.onSnapshot((snapshot: DocumentSnapshot) => {
      if (snapshot.exists) {
        let document: Document = Document.fromDocumentReference(snapshot.ref);
        document.setData(snapshot, specificProperties);
        onChangeListener(new QueryResult([document], specificProperties.length > 0), null);
      } else {
        onChangeListener(null, Error('No such document'));
      }
    }, error => onChangeListener(null, error));
  } else {
    unsubscribeListener = reference.onSnapshot((snapshot: QuerySnapshot) => {
      let documents: Document[] = [];
      snapshot.forEach((documentSnapshot: QueryDocumentSnapshot) => {
        if (documentSnapshot.exists) {
          let document: Document = Document.fromDocumentReference(documentSnapshot.ref);
          document.setData(documentSnapshot, specificProperties);
          documents.push(document);
        }
      });
      onChangeListener(new QueryResult(documents, specificProperties.length > 0), null);
    }, error => onChangeListener(null, error));
  }
}

enum ComponentType {
  LITERAL = 'literal',
  ALL = 'all',
  COLLECTION_EXPRESSION = 'collectionExpression',
  DOCUMENT_EXPRESSION = 'documentExpression',
}

export enum QueryType {
  DOCUMENT,
  COLLECTION,
}

const getQueryType = (components): QueryType =>
    components.filter(c => c.type === ComponentType.LITERAL)
        .length % 2 ?
        QueryType.COLLECTION :
        QueryType.DOCUMENT;

let firebaseAppsInitialized = [];
let firestore: FirebaseFirestore.Firestore;

const parseQuery = (components) => {
  let documentExpression = false;

  const currentProject = auth.getCurrentProject();
  if (!firebaseAppsInitialized.includes(currentProject)) {
    const serviceAccount = require(`../projects/${currentProject}`);
    FirebaseAdmin.initializeApp({
      credential: FirebaseAdmin.credential.cert(serviceAccount),
      databaseURL: serviceAccount.databaseURL,
    }, currentProject);
    firebaseAppsInitialized.push(currentProject);
    firestore = FirebaseAdmin.firestore(FirebaseAdmin.app(currentProject));
    firestore.settings({timestampsInSnapshots: true});
  }

  firestore = FirebaseAdmin.firestore(FirebaseAdmin.app(currentProject));

  let reference: any = firestore;
  let collection = true;
  let specificProperties: string[] = [];

  for (const component of components) {
    switch (component.type) {
      case ComponentType.LITERAL:
        const url = component.value;
        if (collection) {
          collection = false;
          reference = reference.collection(url);
        } else {
          collection = true;
          reference = reference.doc(url);
        }
        break;
      case ComponentType.ALL:
        collection = true;
        break;
      case ComponentType.COLLECTION_EXPRESSION:
        if (reference instanceof CollectionReference) {
          for (const expressionComponent of component.components) {
            if (expressionComponent.type === 'where') {
              reference = (<CollectionReference>reference).where(
                  expressionComponent.field,
                  expressionComponent.operator,
                  expressionComponent.value,
              );
            } else if (expressionComponent.type === 'limit') {
              reference = (<CollectionReference>reference).limit(expressionComponent.limit);
            } else if (expressionComponent.type === 'order') {
              reference = (<CollectionReference>reference).orderBy(
                  expressionComponent.field,
                  expressionComponent.direction === 1 ? 'asc' : 'desc',
              );
            }
          }
        }
        break;
      case ComponentType.DOCUMENT_EXPRESSION:
        specificProperties = component.components;
        documentExpression = true;
        break;
    }
  }
  return {
    reference,
    specificProperties,
    documentExpression,
  };
};

const getResult = async (queryString: string, queryType, reference: any, specificProperties: string[]): Promise<Document[]> => {
  let documents: Document[] = [];

  if (queryType === QueryType.DOCUMENT) {
    const snapshot = await reference.get();
    if (snapshot.exists) {
      const document: Document = Document.fromDocumentReference(reference);
      document.setData(snapshot, specificProperties);
      documents.push(document);
    } else {
      throw new Error('No such document');
    }
  } else {
    const snapshot = await reference.get();
    snapshot.forEach((docSnapshot: QueryDocumentSnapshot) => {
      const document: Document = Document.fromDocumentReference(docSnapshot.ref);
      document.setData(docSnapshot, specificProperties);
      documents.push(document);
    });
  }
  return documents;
};