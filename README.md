# Vox Studio — version française

Application web locale de prévisualisation, d'amplification et d'amélioration audio d'une vidéo.

## Fonctionnalités
- Import et prévisualisation d'une vidéo dans le navigateur.
- Amplification audio réglable jusqu'à 100×.
- Réduction des bruits faibles grâce à un seuil audio réglable.
- Filtre d'isolation vocale : atténuation des fréquences graves et aiguës pour mettre la voix en avant.
- Prévisualisation en direct et exportation du flux traité.
- Traitement local : les fichiers ne sont pas envoyés à un serveur.

## Utilisation
Ouvrir `index.html` dans une version récente de Chrome ou Edge, importer une vidéo, puis activer les effets audio souhaités. Lancer la lecture pour écouter les changements et exporter la vidéo. Les formats d’exportation proposés sont détectés automatiquement selon les capacités réelles du navigateur.

## Limites audio
La réduction des bruits est un gate audio : elle atténue surtout les sons faibles entre les passages sonores. Le filtre d'isolation vocale privilégie la plage de fréquences de la parole, mais ne sépare pas parfaitement une voix d'une musique ou d'autres sons superposés. Une véritable séparation de sources nécessite un modèle IA spécialisé.

L'exportation utilise les capacités MediaRecorder du navigateur. Les formats disponibles dépendent du navigateur et de l'appareil.
