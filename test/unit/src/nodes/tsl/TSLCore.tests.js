import { Fn, Loop, float, int, nodeObject, nodeObjectAssignable, positionGeometry, storage, texture, uniform, uniformGroup, uv, vec2, vec4 } from '../../../../../src/Three.TSL.js';
import { DataTexture, NodeMaterial, QuadMesh, RenderTarget, StorageBufferAttribute, WebGLCoordinateSystem, WebGPUCoordinateSystem } from '../../../../../src/Three.WebGPU.js';
import { getSharedRenderer } from './gpu-test-utils.js';
import { builders } from '../../../tsl/code.js';

export default QUnit.module( 'Nodes', () => {

	QUnit.module( 'TSL', () => {

		QUnit.module( 'TSLCore', () => {

			for ( const [ language, Builder ] of Object.entries( builders ) ) {

				QUnit.test( `Layout Fn reuses a cached function across builders (${ language })`, ( assert ) => {

					const coordinateSystem = language === 'glsl' ? WebGLCoordinateSystem : WebGPUCoordinateSystem;
					const renderer = { backend: {}, coordinateSystem, debug: { diagnostics: { keywords: false } } };
					let builds = 0;
					const helper = Fn( ( [ x ] ) => {

						builds ++;
						const result = x.toVar();
						Loop( 2, () => result.addAssign( 0.1 ) );
						return result;

					}, { x: 'float', return: 'float' } );

					for ( let i = 0; i < 2; i ++ ) {

						const builder = new Builder( null, renderer );
						builder.context.material = new NodeMaterial();
						builder.setShaderStage( 'fragment' );
						builder.flowStagesNode( helper( float( i ) ) );

					}

					assert.strictEqual( builds, 1, 'Compatible builders reuse the function without rebuilding its body' );

				} );

				QUnit.test( `Layout Fn registers captured dependencies for each builder and shader stage (${ language })`, ( assert ) => {

					const coordinateSystem = language === 'glsl' ? WebGLCoordinateSystem : WebGPUCoordinateSystem;
					const renderer = { backend: {}, coordinateSystem, debug: { diagnostics: { keywords: false } } };
					const offset = uniform( 0.2 ).setGroup( uniformGroup( 'captured' ) );
					let builds = 0;
					const inner = Fn( ( [ x ] ) => {

						builds ++;
						return x.add( offset );

					}, { x: 'float', return: 'float' } );
					const helper = Fn( ( [ x ] ) => inner( x ), { x: 'float', return: 'float' } );

					for ( let i = 0; i < 2; i ++ ) {

						const builder = new Builder( null, renderer );

						for ( const stage of [ 'vertex', 'fragment' ] ) {

							builder.setShaderStage( stage );
							// Occupy different resource names and bind groups to catch references from earlier builds.
							for ( let j = 0; j <= i; j ++ ) builder.flowStagesNode( uniform( j ) );

							builder.flowStagesNode( helper( float( 0.5 ) ) );

							const fn = builder.buildFunctionNode( helper.shaderNode );
							const resource = builder.uniforms[ stage ].find( item => item.node === offset );

							assert.ok( resource, `Builder ${ i }, ${ stage } registers the captured uniform` );

							if ( resource ) {

								assert.true( builder.getCodes( stage ).includes( builder.getPropertyName( resource ) ), 'Nested function references the current resource name and group' );
								assert.true( builder.getUniforms( stage ).includes( resource.name ), 'The shader declares the captured resource' );

							}

							builder.flowStagesNode( helper( float( 0.6 ) ) );
							assert.strictEqual( builder.buildFunctionNode( helper.shaderNode ), fn, 'Calls in the same stage reuse the function' );
							assert.strictEqual( builder.codes[ stage ].length, 2, 'Both nested functions are declared only once' );
							assert.false( builder.getCodes( stage ).includes( '%%resource' ), 'All resource references are resolved' );

						}

					}

					assert.strictEqual( builds, 2, 'The captured function body is built once per stage, not once per builder' );

				} );

				QUnit.test( `Layout Fn cache hits preserve resource allocation order (${ language })`, ( assert ) => {

					const coordinateSystem = language === 'glsl' ? WebGLCoordinateSystem : WebGPUCoordinateSystem;
					const renderer = { backend: {}, coordinateSystem, debug: { diagnostics: { keywords: false } } };
					const offset = uniform( 0.2 );
					const nestedOffset = uniform( 0.3 );
					const unrelated = uniform( 0.4 );
					const inner = Fn( ( [ x ] ) => x.add( nestedOffset ), { x: 'float', return: 'float' } );
					const helper = Fn( ( [ x ] ) => x.add( offset ).add( inner( x ) ), { x: 'float', return: 'float' } );
					const sources = [];

					for ( let i = 0; i < 2; i ++ ) {

						const builder = new Builder( null, renderer );
						builder.setShaderStage( 'fragment' );
						const flow = builder.flowStagesNode( vec4( unrelated, helper( float( 0.5 ) ), 0, 1 ) );
						sources.push( [ builder.getCodes( 'fragment' ), flow.code, flow.result, builder.getUniforms( 'fragment' ) ] );

					}

					assert.deepEqual( sources[ 1 ], sources[ 0 ], 'A cache hit does not change shader source or break pipeline reuse' );

				} );

				QUnit.test( `Layout Fn checks nested builder context dependencies (${ language })`, ( assert ) => {

					const coordinateSystem = language === 'glsl' ? WebGLCoordinateSystem : WebGPUCoordinateSystem;
					const renderer = { backend: {}, coordinateSystem, debug: { diagnostics: { keywords: false } } };
					const inner = Fn( ( [ x ], builder ) => x.add( builder.context.offset ), { x: 'float', return: 'float' } );
					const helper = Fn( ( [ x ] ) => inner( x ), { x: 'float', return: 'float' } );

					for ( let i = 0; i < 2; i ++ ) {

						const builder = new Builder( null, renderer );
						const offset = uniform( i );
						builder.context.offset = offset;
						builder.setShaderStage( 'fragment' );
						builder.flowStagesNode( helper( float( 0.5 ) ) );

						assert.true( builder.uniforms.fragment.some( resource => resource.node === offset ), 'Nested function uses the current context resource' );

					}

					const material = new NodeMaterial();
					material.userData.offset = uniform( 0.2 );
					let builds = 0;
					const materialHelper = Fn( ( [ x ], builder ) => {

						builds ++;
						return x.add( builder.material.userData.offset );

					}, { x: 'float', return: 'float' } );

					for ( let i = 0; i < 3; i ++ ) {

						if ( i === 1 ) {

							material.userData.offset = uniform( 0.3 );
							material.needsUpdate = true;

						}

						const builder = new Builder( null, renderer );
						builder.material = material;
						builder.context.material = material;
						builder.setShaderStage( 'fragment' );
						builder.flowStagesNode( materialHelper( float( 0.5 ) ) );

						assert.true( builder.uniforms.fragment.some( resource => resource.node === material.userData.offset ), 'Material version changes invalidate the previous function' );

					}

					assert.strictEqual( builds, 2, 'The updated template is cached again after invalidation' );

					const state = { offset: uniform( 0.2 ) };
					const contextual = Fn( ( [ x ], builder ) => x.add( builder.context.state.offset ), { x: 'float', return: 'float' } );

					for ( let i = 0; i < 2; i ++ ) {

						state.offset = uniform( i );
						const builder = new Builder( null, renderer );
						builder.context.state = state;
						builder.setShaderStage( 'fragment' );
						builder.flowStagesNode( contextual( float( 0.5 ) ) );

						assert.true( builder.uniforms.fragment.some( resource => resource.node === state.offset ), 'Opaque mutable context is not mistaken for a reusable template' );

					}

				} );

			}

			for ( const backend of [ 'webgpu', 'webgl' ] ) {

				QUnit.test( `Layout Fn reuses captured textures and storage across stages and materials (${ backend })`, async ( assert ) => {

					const renderer = await getSharedRenderer( backend );

					if ( renderer === null ) {

						assert.ok( true, `SKIPPED: "${ backend }" backend is not available in this environment.` );
						return;

					}

					const map = new DataTexture( new Uint8Array( [ 51, 0, 0, 255 ] ), 1, 1 );
					map.needsUpdate = true;
					const attribute = new StorageBufferAttribute( new Float32Array( [ 0.2 ] ), 1 );
					const captures = [ texture( map, vec2( 0.5 ) ).r, storage( attribute, 'float', 1 ).setPBO( true ).toReadOnly().element( 0 ) ];
					const target = new RenderTarget( 1, 1 );
					const previousTarget = renderer.getRenderTarget();

					try {

						renderer.setRenderTarget( target );

						for ( const capture of captures ) {

							const warmup = Fn( ( [ x ] ) => x.add( capture ), { x: 'float', return: 'float' } ).once();
							let builds = 0;
							const inner = Fn( ( [ x ] ) => {

								builds ++;
								return x.add( capture );

							}, { x: 'float', return: 'float' } );
							const helper = Fn( ( [ x ] ) => inner( x ), { x: 'float', return: 'float' } );

							for ( let i = 0; i < 2; i ++ ) {

								const material = new NodeMaterial();
								// Prime native code so dependency tracking cannot rely on CodeNode.generate being called.
								const prefix = i === 0 ? warmup( float( 0 ) ).mul( 0 ) : float( 0 );
								material.vertexNode = vec4( positionGeometry.xy, prefix.add( helper( float( 0 ) ).mul( 0.1 ) ), 1 );
								material.fragmentNode = vec4( prefix.add( helper( uv().x ) ), uv().y, float( i * 0.01 ), 1 );
								const quad = new QuadMesh( material );

								try {

									await renderer.compileAsync( quad, quad.camera );
									renderer.render( quad, quad.camera );
									const pixel = await renderer.readRenderTargetPixelsAsync( target, 0, 0, 1, 1 );
									const expected = [ 0.7 * 255, 0.5 * 255, i * 0.01 * 255, 255 ];

									assert.true( pixel.every( ( value, channel ) => Math.abs( value - expected[ channel ] ) <= 1 ), `Material ${ i } renders the captured resource: ${ Array.from( pixel ) }` );

								} finally {

									material.dispose();

								}

							}

							assert.strictEqual( builds, 2, 'Both materials reuse the captured function body in each stage' );

						}

					} finally {

						renderer.setRenderTarget( previousTarget );
						target.dispose();
						map.dispose();

					}

				} );

				QUnit.test( `Layout Fn shares a captured uniform across materials (${ backend })`, async ( assert ) => {

					const renderer = await getSharedRenderer( backend );

					if ( renderer === null ) {

						assert.ok( true, `SKIPPED: "${ backend }" backend is not available in this environment.` );
						return;

					}

					const offset = uniform( 0.2 );
					const helper = Fn( ( [ x ] ) => x.add( offset ), { x: 'float', return: 'float' } );
					const target = new RenderTarget( 1, 1 );
					const previousTarget = renderer.getRenderTarget();

					try {

						renderer.setRenderTarget( target );

						for ( let i = 0; i < 2; i ++ ) {

							const material = new NodeMaterial();
							// Use different shader sources so pipeline reuse cannot hide missing resources.
							material.fragmentNode = vec4( helper( uv().x ), uv().y, float( i * 0.01 ), 1 );
							const quad = new QuadMesh( material );

							try {

								await renderer.compileAsync( quad, quad.camera );
								renderer.render( quad, quad.camera );

								const pixel = await renderer.readRenderTargetPixelsAsync( target, 0, 0, 1, 1 );
								const expected = [ 0.7 * 255, 0.5 * 255, i * 0.01 * 255, 255 ];

								for ( let channel = 0; channel < 4; channel ++ ) {

									assert.true( Math.abs( pixel[ channel ] - expected[ channel ] ) <= 1, `Material ${ i }, channel ${ channel }: ${ pixel[ channel ] }` );

								}

							} finally {

								material.dispose();

							}

						}

					} finally {

						renderer.setRenderTarget( previousTarget );
						target.dispose();

					}

				} );

			}

			QUnit.test( 'Scalar constant independence', ( assert ) => {

				for ( const value of [ 0, 1, 2, 3, - 1, - 2 ] ) {

					for ( const [ name, create ] of Object.entries( { int, float } ) ) {

						const first = create( value );
						const second = create( value );

						assert.notStrictEqual( first, second, `${ name }(${ value }) creates independent constants` );
						assert.strictEqual( first.value, value, `${ name }(${ value }) preserves the value` );
						assert.strictEqual( second.value, value, `${ name }(${ value }) preserves the second value` );
						assert.true( first.assignable, `${ name }(${ value }) is assignable` );
						assert.false( first.isWeak, `${ name }(${ value }) keeps its explicit type` );

					}

				}

			} );

			QUnit.test( 'Assignable shared constants', ( assert ) => {

				const shared = nodeObject( 1 );
				const first = nodeObjectAssignable( 1 );
				const second = nodeObjectAssignable( shared );

				assert.strictEqual( nodeObject( 1 ), shared, 'Plain constants remain cached' );
				assert.notStrictEqual( first, shared, 'Assignable constants do not reuse the shared node' );
				assert.notStrictEqual( second, shared, 'A shared constant passed as a node is copied' );
				assert.notStrictEqual( first, second, 'Assignable constants remain independent' );
				assert.false( shared.assignable, 'The cached constant remains unchanged' );
				assert.true( first.assignable, 'The first copy is assignable' );
				assert.true( second.assignable, 'The second copy is assignable' );
				assert.strictEqual( first.isWeak, shared.isWeak, 'The copy preserves implicit numeric typing' );
				assert.strictEqual( first.toAssignable(), first, 'toAssignable() preserves node identity' );
				assert.strictEqual( nodeObjectAssignable( first ), first, 'A node outside the shared cache retains its identity' );

			} );

		} );

	} );

} );
